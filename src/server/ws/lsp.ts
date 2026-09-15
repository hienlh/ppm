/**
 * The bridge between a browser tab and the language servers.
 *
 * This is the seam VS Code puts between its renderer and its extension host,
 * in the same place and for the same reason: the editor should not know that a
 * server process exists, and the server should not know that a browser does.
 *
 * The browser speaks paths and this speaks URIs. That direction matters — the
 * browser is untrusted input, so turning a path into a URI (and refusing one
 * that leaves the project) has to happen here rather than being sent in
 * pre-made. A language server will happily read any file it is pointed at.
 *
 * Document text is synchronised incrementally, as VS Code does, but every
 * change carries the version it applies to. A dropped or reordered change
 * otherwise desynchronises the server's copy of the file silently, and from
 * then on every completion and diagnostic refers to lines that no longer exist
 * — with nothing anywhere reporting a problem. On a version gap the bridge
 * asks the browser to resend the whole document instead.
 */
import { resolve, sep } from "node:path";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import { isUnavailable, lspManager } from "../../services/lsp/lsp-manager.ts";
import { pathToFileUri, uriKey } from "../../shared/lsp-uri.ts";

interface OpenDoc {
  /** Session key, for releasing the hold when the document closes. */
  key: string;
  languageId: string;
  version: number;
  /** `file:` URI the language server knows the document by. */
  uri: string;
  /**
   * The URI the browser's Monaco model has.
   *
   * PPM mounts its editors with a value and no path, so Monaco names its models
   * `inmemory://model/N`. A language server has never heard of that, and the
   * `file:` URIs it answers with match no model, so neither side can use the
   * other's name and this is the only place that knows both.
   */
  clientUri: string;
}

interface Client {
  ws: WsLike;
  /** Identifies this socket to the manager's reference counting. */
  id: string;
  projectPath: string;
  docs: Map<string, OpenDoc>;
}

interface WsLike {
  data: { type: string; projectName?: string };
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
}

const clients = new Map<WsLike, Client>();
let nextClientId = 1;

/**
 * Resolve a project-relative path and refuse anything that leaves the project.
 *
 * The path arrives from the browser. Without this a document URI of
 * `../../../.ssh/id_rsa` would be handed to a language server as something to
 * read and report on.
 */
export function resolveDocumentPath(projectPath: string, relativePath: string): string {
  if (!relativePath || /[\x00-\x1f]/.test(relativePath)) {
    throw new Error(`Invalid document path: ${JSON.stringify(relativePath)}`);
  }
  const absolute = resolve(projectPath, relativePath);
  if (absolute !== projectPath && !absolute.startsWith(projectPath + sep)) {
    throw new Error(`Document path escapes the project: ${relativePath}`);
  }
  return absolute;
}

function send(client: Client, message: unknown): void {
  try {
    client.ws.send(JSON.stringify(message));
  } catch {
    // The socket went away between the check and the write; `close` cleans up.
  }
}

function handleOpen(ws: WsLike): void {
  const projectName = ws.data.projectName;
  if (!projectName) {
    ws.close(1008, "missing project");
    return;
  }
  let projectPath: string;
  try {
    projectPath = resolveProjectPath(projectName);
  } catch (e) {
    ws.close(1008, e instanceof Error ? e.message : "unknown project");
    return;
  }
  const client: Client = { ws, id: `lsp-${nextClientId++}`, projectPath, docs: new Map() };
  clients.set(ws, client);
  // Announce the fresh socket. A reconnect gives the browser a server that has
  // never heard of its open documents, and nothing else would tell it that:
  // the socket layer replays queued messages, but a document opened before the
  // drop was never queued. On `hello` the browser re-opens what it still has.
  send(client, { t: "hello" });
}

async function handleMessage(ws: WsLike, raw: string | Buffer): Promise<void> {
  const client = clients.get(ws);
  if (!client) return;

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return;
  }

  try {
    switch (msg.t) {
      case "open":
        await openDocument(client, msg);
        break;
      case "change":
        changeDocument(client, msg);
        break;
      case "save":
        saveDocument(client, msg);
        break;
      case "close":
        closeDocument(client, msg);
        break;
      case "request":
        await forwardRequest(client, msg);
        break;
      case "cancel":
        // The session cancels on timeout by itself; an explicit cancel from a
        // provider that lost interest just saves the server some work.
        break;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (typeof msg.id === "number") send(client, { t: "error", id: msg.id, message });
    else send(client, { t: "notice", message });
  }
}

async function openDocument(client: Client, msg: Record<string, unknown>): Promise<void> {
  const path = String(msg.path ?? "");
  const text = String(msg.text ?? "");
  const version = Number(msg.version ?? 1);
  const absolute = resolveDocumentPath(client.projectPath, path);

  const result = await lspManager.acquire(client.projectPath, absolute, client.id);
  if (isUnavailable(result)) {
    send(client, {
      t: "unavailable",
      path,
      reason: result.reason,
      server: result.server ?? null,
      message: result.message,
    });
    return;
  }

  const uri = pathToFileUri(absolute);
  const clientUri = String(msg.clientUri ?? uri);
  client.docs.set(path, { key: result.key, languageId: result.language, version, uri, clientUri });

  result.session.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: result.language, version, text },
  });

  send(client, {
    t: "ready",
    path,
    languageId: result.language,
    server: {
      id: result.session.definition.id,
      displayName: result.session.definition.displayName,
      rootPath: result.session.rootPath,
    },
    // The browser needs this to turn a `file:` URI the server reported into a
    // project-relative path it can fetch and open.
    projectPath: client.projectPath,
    // The browser registers only the providers the server actually offers, so
    // a feature the server lacks is absent rather than silently empty.
    capabilities: result.session.serverCapabilities,
  });
}

function changeDocument(client: Client, msg: Record<string, unknown>): void {
  const path = String(msg.path ?? "");
  const doc = client.docs.get(path);
  if (!doc) return;
  const session = sessionFor(doc);
  if (!session) return;

  const version = Number(msg.version ?? 0);
  const full = typeof msg.text === "string";

  // A change must apply to the version we last saw. Anything else means the
  // stream skipped, and continuing would leave the server's copy quietly wrong.
  if (!full && version !== doc.version + 1) {
    send(client, { t: "resync", path });
    return;
  }

  const contentChanges = full
    ? [{ text: String(msg.text) }]
    : (msg.changes as Array<{ range: unknown; text: string }> | undefined) ?? [];
  if (contentChanges.length === 0) return;

  doc.version = version;
  session.notify("textDocument/didChange", {
    textDocument: { uri: doc.uri, version },
    contentChanges,
  });
}

function saveDocument(client: Client, msg: Record<string, unknown>): void {
  const doc = client.docs.get(String(msg.path ?? ""));
  if (!doc) return;
  sessionFor(doc)?.notify("textDocument/didSave", {
    textDocument: { uri: doc.uri },
    ...(typeof msg.text === "string" ? { text: msg.text } : {}),
  });
}

function closeDocument(client: Client, msg: Record<string, unknown>): void {
  const path = String(msg.path ?? "");
  const doc = client.docs.get(path);
  if (!doc) return;
  client.docs.delete(path);
  sessionFor(doc)?.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });

  // Only give up the hold when this socket has no other document on that
  // session, or closing one of ten TypeScript tabs would start the reap timer.
  if (![...client.docs.values()].some((other) => other.key === doc.key)) {
    lspManager.release(doc.key, client.id);
  }
}

async function forwardRequest(client: Client, msg: Record<string, unknown>): Promise<void> {
  const id = Number(msg.id);
  const path = String(msg.path ?? "");
  const doc = client.docs.get(path);
  if (!doc) {
    send(client, { t: "error", id, message: `No language server is open for ${path}` });
    return;
  }
  const session = sessionFor(doc);
  if (!session) {
    send(client, { t: "error", id, message: "The language server is no longer running" });
    return;
  }

  // The browser addressed the document by its Monaco URI; the server only
  // knows the `file:` one.
  const params = withDocumentUri(msg.params, doc.uri);
  const result = await session.request(String(msg.method), params);
  // And back: a location in this file has to come home as the model's URI or
  // Monaco treats its own file as a different one and tries to open an editor
  // for it instead of jumping.
  send(client, { t: "response", id, result: rewriteUris(result, uriMapFor(client)) });
}

/** Replace `textDocument.uri` with the one the language server knows. */
export function withDocumentUri(params: unknown, uri: string): unknown {
  if (!params || typeof params !== "object") return params;
  const source = params as Record<string, unknown>;
  const textDocument = source.textDocument as Record<string, unknown> | undefined;
  if (!textDocument) return params;
  return { ...source, textDocument: { ...textDocument, uri } };
}

/** file: URI to the browser's model URI, for every document this socket has open. */
function uriMapFor(client: Client): Map<string, string> {
  const map = new Map<string, string>();
  for (const doc of client.docs.values()) map.set(uriKey(doc.uri), doc.clientUri);
  return map;
}

/**
 * Rewrite every URI in a server response that names a document this socket has
 * open.
 *
 * Walks the whole value because `uri` turns up in a dozen shapes — a location,
 * a location link's `targetUri`, each key of a workspace edit's `changes`, a
 * diagnostic's related information. A URI for a file that is *not* open is left
 * alone: the browser turns that into a path and opens a tab for it.
 */
export function rewriteUris(value: unknown, map: Map<string, string>): unknown {
  if (map.size === 0 || value == null) return value;
  if (Array.isArray(value)) return value.map((entry) => rewriteUris(entry, map));
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "uri" || key === "targetUri") && typeof entry === "string") {
      out[key] = map.get(uriKey(entry)) ?? entry;
      continue;
    }
    // A workspace edit keys its changes *by* URI, so the keys need it too.
    if (key === "changes" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      const changes: Record<string, unknown> = {};
      for (const [uri, edits] of Object.entries(entry as Record<string, unknown>)) {
        changes[map.get(uriKey(uri)) ?? uri] = rewriteUris(edits, map);
      }
      out[key] = changes;
      continue;
    }
    out[key] = rewriteUris(entry, map);
  }
  return out;
}

/** The live session behind a document, or null if it went away. */
function sessionFor(doc: OpenDoc) {
  const running = lspManager.sessionFor(doc.key);
  return running && running.state === "ready" ? running : null;
}

function handleClose(ws: WsLike): void {
  const client = clients.get(ws);
  if (!client) return;
  clients.delete(ws);
  // Tell each server the documents are gone before dropping the holds, so a
  // server does not keep diagnostics for files nobody has open.
  for (const doc of client.docs.values()) {
    lspManager.sessionFor(doc.key)?.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });
  }
  client.docs.clear();
  lspManager.releaseAll(client.id);
}

/**
 * Server-initiated traffic — diagnostics above all — fanned out to the tabs
 * that have a document on that session.
 *
 * Registered once for the module rather than per socket: the manager shares one
 * session between tabs, so a per-socket listener would deliver every other
 * tab's diagnostics too.
 */
lspManager.onNotification((key, method, params) => {
  for (const client of clients.values()) {
    if (![...client.docs.values()].some((doc) => doc.key === key)) continue;
    // Diagnostics name their document by URI; unrewritten, the browser cannot
    // tell which model they belong to and would show none at all.
    send(client, { t: "notification", method, params: rewriteUris(params, uriMapFor(client)) });
  }
});

export const lspWebSocket = {
  open: handleOpen,
  message: (ws: WsLike, msg: string | Buffer) => void handleMessage(ws, msg),
  close: handleClose,
};
