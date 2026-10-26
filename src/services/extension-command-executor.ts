import type { ExecuteErrorCode } from "../shared/extension-command-execute.ts";
import type { ExtensionManifest } from "../types/extension.ts";

/**
 * Runs a declared extension command for a caller outside the browser (the REST route behind
 * `ppm <alias>` / `ppm ext run`). Never throws: every way it can fail is a code the route maps
 * to an HTTP status and the CLI maps to an exit code.
 */
export type ExecuteOutcome =
  | { kind: "ok"; extensionId: string; result: unknown; durationMs: number }
  | { kind: "error"; code: ExecuteErrorCode; message: string; extensionId?: string; durationMs: number };

/** What the worker's `ext:command:execute` handler answers. */
export interface WorkerCommandReply {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

export interface CommandExecutorDeps {
  isHostReady(): boolean;
  /** Commands of activated extensions, with the extension that declared each. */
  activeCommands(): Array<{ command: string; extId: string }>;
  /** Every installed extension's manifest, activated or not. */
  installedManifests(): Array<{ id: string; enabled: boolean; manifest: ExtensionManifest }>;
  /** Why an extension failed to activate, if it did. */
  activationError(id: string): string | undefined;
  send(command: string, args: unknown[], timeoutMs: number): Promise<WorkerCommandReply>;
  now?(): number;
}

/** The RPC channel's own timeout rejection, as opposed to any other failure to deliver. */
function isRpcTimeout(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("RPC timeout:");
}

export async function executeExtensionCommand(
  deps: CommandExecutorDeps,
  command: string,
  args: unknown[],
  timeoutMs: number,
): Promise<ExecuteOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const fail = (code: ExecuteErrorCode, message: string, extensionId?: string): ExecuteOutcome =>
    ({ kind: "error", code, message, extensionId, durationMs: now() - startedAt });

  if (!deps.isHostReady()) return fail("HOST_NOT_READY", "The extension host is not ready yet");

  const declared = deps.activeCommands().find((c) => c.command === command);
  if (!declared) {
    // The registry only holds activated extensions; a declaration elsewhere means the owner is
    // installed but disabled or failed to activate, which is a different fix for the user.
    const owner = deps.installedManifests().find((e) =>
      e.manifest.contributes?.commands?.some((c) => c.command === command));
    if (!owner) return fail("NOT_FOUND", `No installed extension declares the command ${command}`);
    const error = deps.activationError(owner.id);
    if (!owner.enabled || error) {
      const why = owner.enabled ? `failed to activate: ${error}` : "is disabled";
      return fail("NOT_ACTIVE", `Extension ${owner.id} declares ${command} but ${why}`, owner.id);
    }
    // Enabled with no failure recorded: its activation has not run yet (PPM is still starting).
    return fail("HOST_NOT_READY", `Extension ${owner.id} is not active yet; PPM may still be starting`, owner.id);
  }

  let reply: WorkerCommandReply;
  try {
    reply = await deps.send(command, args, timeoutMs);
  } catch (e) {
    if (isRpcTimeout(e)) {
      return fail("TIMEOUT", `${command} did not answer within ${timeoutMs} ms (it may still be running)`, declared.extId);
    }
    // Host rebuilt or torn down mid-call: the command's fate is unknown, so it is not "not ready".
    return fail("COMMAND_FAILED", e instanceof Error ? e.message : String(e), declared.extId);
  }

  if (!reply || typeof reply !== "object") return fail("COMMAND_FAILED", "The extension host gave no answer", declared.extId);
  if (!reply.ok) {
    if (reply.code === "NOT_FOUND") {
      return fail("NOT_FOUND", `${command} is declared by ${declared.extId} but no handler is registered`, declared.extId);
    }
    return fail("COMMAND_FAILED", reply.error || `${command} failed`, declared.extId);
  }
  return { kind: "ok", extensionId: declared.extId, result: reply.result ?? null, durationMs: now() - startedAt };
}
