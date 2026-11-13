import { providerRegistry } from "../providers/registry.ts";
import { clampBoundPermissionMode } from "../providers/extension-tool-policy.ts";
import {
  copyExtensionSessionBinding, deleteExtensionSessionBinding, getExtensionSessionBinding, getSessionProvider, insertExtensionSessionBinding,
  resolveMigratedSession, updateExtensionSessionBinding, type ExtensionSessionBindingRow,
} from "./db.service.ts";
import {
  validateBindingInput, validateToolPolicy, validateToolsets,
  type ExtensionSessionBinding, type ExtensionToolPolicy,
} from "../shared/extension-session-binding.ts";

/**
 * Instructions, toolsets and a tool policy an extension attaches to a chat session — kept in
 * PPM's database so they apply to every turn of that session, typed in its tab or started
 * headless. An extension may bind only a session it created with `bindable: true`: the row is
 * written then, owned by that extension, and `bind` only ever updates it. Every extension
 * shares one worker channel and names itself on each call, so ownership keeps a mistaken
 * extension off a person's chats and off other extensions' sessions; it is not isolation
 * against a hostile one (extensions are trusted code).
 *
 * A live Claude query keeps the system prompt, tools and policy it was started with, so a
 * change is put in force by restarting it (the `chat:bind` handler does, once it is idle).
 *
 * The binding outlives what it came from in both directions. A fork or an edited version of
 * a bound chat gets a copy, so it is never more open than its source. And when the owning
 * extension is removed the row stays, marked: the chat is closed rather than unbound, since
 * an unbound chat would run with every tool.
 */

export const BINDING_CLAUDE_ONLY = "Chỉ hỗ trợ Claude";

export function providerSupportsBinding(providerId: string): boolean {
  return !!providerRegistry.get(providerId)?.supportsExtensionBinding;
}

/** Parsed and re-validated: a stored policy that no longer reads back is an error, never "no policy". */
function parseRow(row: ExtensionSessionBindingRow): ExtensionSessionBinding {
  return {
    sessionId: row.session_id,
    extensionId: row.extension_id,
    instructions: row.instructions,
    toolsets: validateToolsets(JSON.parse(row.toolsets_json)),
    toolPolicy: row.tool_policy_json === null ? null : validateToolPolicy(JSON.parse(row.tool_policy_json)),
    updatedAt: row.updated_at,
  };
}

/** The row under the session's current id, or under the id asked for when it never moved. */
function findRow(sessionId: string): ExtensionSessionBindingRow | null {
  const current = resolveMigratedSession(sessionId);
  return getExtensionSessionBinding(current) ?? (current === sessionId ? null : getExtensionSessionBinding(sessionId));
}

function ownedRow(sessionId: string, extensionId: string): ExtensionSessionBindingRow {
  const row = findRow(sessionId);
  if (row && row.extension_id === extensionId && !row.extension_removed_at) return row;
  const providerId = getSessionProvider(resolveMigratedSession(sessionId));
  if (providerId && !providerSupportsBinding(providerId)) throw new Error(BINDING_CLAUDE_ONLY);
  throw new Error("Session was not created as bindable by this extension");
}

/** Called by `chat:createSession` with `bindable: true`, after the provider made the session. */
export function createBindableSession(sessionId: string, extensionId: string): void {
  insertExtensionSessionBinding(sessionId, extensionId);
}

/** A field the caller leaves out keeps its value; `null` clears it. */
export function bindSession(sessionId: string, extensionId: string, input: unknown): ExtensionSessionBinding {
  const row = ownedRow(sessionId, extensionId);
  const change = validateBindingInput(input);
  const current = parseRow(row);
  const toolPolicy = change.toolPolicy !== undefined ? change.toolPolicy : current.toolPolicy;
  updateExtensionSessionBinding(row.session_id, {
    instructions: change.instructions !== undefined ? change.instructions : current.instructions,
    toolsetsJson: JSON.stringify(change.toolsets ?? current.toolsets),
    toolPolicyJson: toolPolicy ? JSON.stringify(toolPolicy) : null,
  });
  return parseRow(getExtensionSessionBinding(row.session_id)!);
}

/** Clears what is bound and keeps the ownership, so the extension can bind the session again. */
export function unbindSession(sessionId: string, extensionId: string): void {
  const row = ownedRow(sessionId, extensionId);
  updateExtensionSessionBinding(row.session_id, { instructions: null, toolsetsJson: "[]", toolPolicyJson: null });
}

export function getOwnedBinding(sessionId: string, extensionId: string): ExtensionSessionBinding {
  return parseRow(ownedRow(sessionId, extensionId));
}

/** The binding a turn of this session runs under, whoever sent it; null for an unbound session. */
export function sessionBindingFor(sessionId: string): ExtensionSessionBinding | null {
  const row = findRow(sessionId);
  return row ? parseRow(row) : null;
}

export type BoundToolsets = { ok: true; toolsets: string[] } | { ok: false; reason: string };

/**
 * The toolsets this extension's tools may be served from to the session's agent right now, or
 * why none: read on every MCP request, so an unbind, a changed list or a removed extension
 * applies to the very next call.
 */
export function boundToolsetsFor(sessionId: string, extensionId: string): BoundToolsets {
  const row = findRow(sessionId);
  if (!row || row.extension_id !== extensionId) return { ok: false, reason: "This chat is no longer bound to the extension that provides this tool." };
  if (row.extension_removed_at) return { ok: false, reason: "The extension that provided this tool was removed, so the chat is closed." };
  try {
    return { ok: true, toolsets: parseRow(row).toolsets };
  } catch (e) {
    return { ok: false, reason: `This chat's binding cannot be read: ${(e as Error).message}` };
  }
}

/** A fork (or an edited version) of a bound chat: the same owner and binding, closed if the source is. */
export function copyBindingToFork(sourceId: string, forkId: string): void {
  const row = findRow(sourceId);
  if (row) copyExtensionSessionBinding(row.session_id, forkId);
}

export function deleteSessionBinding(sessionId: string): void {
  deleteExtensionSessionBinding(sessionId);
  const current = resolveMigratedSession(sessionId);
  if (current !== sessionId) deleteExtensionSessionBinding(current);
}

export interface BoundTurnOptions {
  extensionInstructions?: string;
  extensionToolPolicy?: ExtensionToolPolicy;
  permissionMode?: string;
}

/**
 * What a binding adds to one turn, or null for an unbound session. A provider that cannot
 * deliver a binding refuses the turn rather than run it with the policy silently dropped.
 */
export function boundTurnOptions(providerId: string, sessionId: string, permissionMode: string | undefined): BoundTurnOptions | null {
  const row = findRow(sessionId);
  if (!row) return null;
  if (row.extension_removed_at) {
    throw new Error(`The extension that managed this chat (${row.extension_id}) was removed, so the chat is closed`);
  }
  const binding = parseRow(row);
  const instructions = binding.instructions?.trim() ? binding.instructions : undefined;
  if (!instructions && !binding.toolPolicy && binding.toolsets.length === 0) return null;
  if (!providerSupportsBinding(providerId)) {
    throw new Error(`Session ${sessionId} is bound by an extension, and only Claude can run it (${BINDING_CLAUDE_ONLY})`);
  }
  return {
    ...(instructions ? { extensionInstructions: instructions } : {}),
    ...(binding.toolPolicy
      ? { extensionToolPolicy: binding.toolPolicy, permissionMode: clampBoundPermissionMode(permissionMode) }
      : {}),
  };
}
