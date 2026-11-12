import { basename, resolve } from "node:path";
import { VERSION } from "../../version.ts";
import { inAiChat } from "../../services/ai-chat-env.ts";
import { discoverServer, type Discovery } from "./server-discovery.ts";
import { INSTANCE_ENV } from "./profile-argv.ts";

/**
 * How a `ppm` command reaches the running PPM that holds its database: find it, prove it
 * (`server-discovery.ts`), then call its routes signed in — the same checks and live updates as
 * PPM's screens. When no server holds the database the caller may write it directly
 * (`ServerDownError`); a server that may exist but cannot be verified is a refusal
 * (`ServerRefusedError`), never a direct write underneath it.
 */

/** No PPM server holds this database: the command may only go to the database, or not run. */
export class ServerDownError extends Error {}
/** A server may hold this database but could not be picked or verified. */
export class ServerRefusedError extends Error {}

/** The PPM to talk to, chosen once per process. */
interface Target { discovery: Discovery; token: string; authEnabled: boolean; profile: string | null; dbFile: string }
let target: Promise<Target> | null = null;
let strictInstance: string | undefined;
let targetPrinted = false;

/** `ppm --instance <pid|id>`: the server must be that one. */
export function setStrictInstance(id: string | undefined): void {
  strictInstance = id;
  target = null;
}

async function resolveTarget(): Promise<Target> {
  const { configService } = await import("../../services/config.service.ts");
  const { getDbPath, getDbProfile } = await import("../../services/db.service.ts");
  const { readStatus } = await import("../../services/supervisor-state.ts");
  if (!configService.isLoaded) configService.load();
  const auth = configService.get("auth");
  const dbFile = getDbPath();
  const profile = getDbProfile();
  const discovery = await discoverServer({
    dbFile, profile, token: auth.token ?? "", configPort: configService.get("port"),
    strictInstance, preferredInstance: process.env[INSTANCE_ENV] || undefined, supervisorStatus: readStatus(),
  });
  return { discovery, token: auth.token ?? "", authEnabled: auth.enabled, profile, dbFile };
}

function currentTarget(): Promise<Target> {
  return (target ??= resolveTarget());
}

/**
 * A command run from an AI chat changes only the PPM that chat belongs to (`PPM_ASSISTANT_DB`).
 * Advisory: the shell's approval card is the control, this only catches a wrong profile.
 */
export function aiChatWriteRefusal(dbFile: string, env: Record<string, string | undefined> = process.env): string | null {
  const expected = env.PPM_ASSISTANT_DB;
  if (!inAiChat(env) || !expected) return null;
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  if (norm(dbFile) === norm(expected)) return null;
  return `This chat belongs to the PPM on ${basename(expected)}; this command would change ${basename(dbFile)}. `
    + "Run it from that PPM, or give the user the command.";
}

function printTarget(t: Target, baseUrl: string): void {
  if (targetPrinted) return;
  targetPrinted = true;
  console.error(`→ PPM ${t.profile ?? "default"} (${basename(t.dbFile)}) at ${baseUrl.replace(/^http:\/\//, "")}`);
}

/**
 * `/api<path>` on the running PPM that holds this command's database. A `FormData` body is sent
 * as a multipart form (an upload); anything else as JSON.
 */
export async function serverRequest<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  const t = await currentTarget();
  if (method !== "GET") {
    const refusal = aiChatWriteRefusal(t.dbFile);
    if (refusal) throw new ServerRefusedError(refusal);
  }
  if (t.discovery.kind === "none") throw new ServerDownError(`No PPM is running on ${basename(t.dbFile)} — start it with 'ppm start'`);
  if (t.discovery.kind === "refused") throw new ServerRefusedError(t.discovery.reason);
  const { baseUrl } = t.discovery.endpoint;
  printTarget(t, baseUrl);
  const headers: Record<string, string> = { "X-PPM-Request": "1", "User-Agent": `ppm-cli/${VERSION}` };
  if (t.authEnabled) headers.Authorization = `Bearer ${t.token}`;
  if (inAiChat()) headers["X-PPM-AI-Chat"] = "1";
  // Every write carries a body, so a route never meets a body-less POST. fetch writes a form's
  // own Content-Type, boundary included.
  const form = body instanceof FormData ? body : undefined;
  const payload = method === "GET" ? undefined : form ?? JSON.stringify(body ?? {});
  if (typeof payload === "string") headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api${path}`, {
      method, headers, body: payload, redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new ServerRefusedError(`The PPM at ${baseUrl} did not answer (${(e as Error).message})`);
  }
  const json = await res.json().catch(() => null) as { ok?: boolean; data?: T; error?: string } | null;
  if (!json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json.data as T;
}

/**
 * The `ws://` URL of one of the running PPM's sockets (`/ws/...`), signed in the way a browser
 * signs its sockets (`?token=`), after the same checks as a write: the server is found and
 * proven, and an AI chat bound to another database is refused.
 */
export async function serverSocketUrl(path: string): Promise<string> {
  const t = await currentTarget();
  const refusal = aiChatWriteRefusal(t.dbFile);
  if (refusal) throw new ServerRefusedError(refusal);
  if (t.discovery.kind === "none") throw new ServerDownError(`No PPM is running on ${basename(t.dbFile)}`);
  if (t.discovery.kind === "refused") throw new ServerRefusedError(t.discovery.reason);
  const { baseUrl } = t.discovery.endpoint;
  printTarget(t, baseUrl);
  const url = new URL(path, baseUrl.replace(/^http:/, "ws:"));
  if (t.authEnabled) url.searchParams.set("token", t.token);
  return url.toString();
}

/**
 * Before writing the database directly because no server holds it: refuses from an AI chat
 * bound to another database, else prints the one-line notice and returns.
 */
export async function noteDirectWrite(): Promise<void> {
  const { getDbPath } = await import("../../services/db.service.ts");
  const dbFile = getDbPath();
  const refusal = aiChatWriteRefusal(dbFile);
  if (refusal) throw new ServerRefusedError(refusal);
  console.error(`→ No PPM is running on ${basename(dbFile)}; written directly`);
}

/** For tests: forget the chosen server. */
export function _resetServerClient(): void {
  target = null;
  strictInstance = undefined;
  targetPrinted = false;
}
