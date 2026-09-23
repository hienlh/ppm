import type { CodexPermission } from "./codex-permission-map.ts";
import type { ThreadStartParams } from "./codex-protocol.ts";

/** The overrides both thread/start and thread/resume carry (resume adds threadId + path). */
export type CodexThreadParams = ThreadStartParams & { config?: Record<string, number> };

export interface ThreadParamsInput {
  cwd: string;
  permission: CodexPermission;
  model?: string;
  /** Provider-wide config overrides, already shaped as `{ config }` or `{}`. */
  configOverrides?: { config?: Record<string, number> };
  developerInstructions?: string;
}

/**
 * One builder for the params of every thread/start and thread/resume — the first connect
 * and the account-switch respawn used to assemble them separately, which is how a field
 * added to one silently goes missing from the other. `developerInstructions` is left out
 * entirely when empty, so an ordinary session sends exactly what it always has.
 */
export function buildThreadParams(input: ThreadParamsInput): CodexThreadParams {
  const instructions = input.developerInstructions?.trim();
  return {
    ...(input.configOverrides ?? {}),
    cwd: input.cwd,
    sandbox: input.permission.sandbox,
    approvalPolicy: input.permission.approvalPolicy,
    ...(input.model ? { model: input.model } : {}),
    ...(instructions ? { developerInstructions: instructions } : {}),
  };
}

/** A codex build that predates `developerInstructions` rejects it as an unknown field. */
export function isUnknownDeveloperInstructionsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /developerInstructions|developer_instructions/.test(message)
    && /unknown|unexpected|unrecognized|not allowed|invalid/i.test(message);
}

/**
 * Send a thread request, and if an older codex refuses the instructions field, send it
 * once more without it — a design session that loses its instructions still works as a
 * chat, while a refused thread/start is no session at all. Logged, never silent.
 */
export async function requestWithInstructionsFallback<T>(
  params: CodexThreadParams,
  send: (params: CodexThreadParams) => Promise<T>,
  log: (message: string) => void = console.warn,
): Promise<T> {
  try {
    return await send(params);
  } catch (err) {
    if (!params.developerInstructions || !isUnknownDeveloperInstructionsError(err)) throw err;
    log("[codex] app-server rejected developerInstructions; retrying without design instructions");
    const { developerInstructions: _dropped, ...rest } = params;
    return send(rest);
  }
}
