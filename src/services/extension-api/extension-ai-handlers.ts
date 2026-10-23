/**
 * `ppm.ai.*` — one-shot completions for extensions. `ai:complete` answers only when the call
 * ends; its outcome travels inside the result (`{ ok, result }` / `{ ok, error: { code } }`)
 * because an RPC error carries a message alone and extensions branch on the code.
 *
 * Every call is registered under the worker generation that asked for it, so rebuilding the
 * worker aborts it, and under the call id the worker made up, so `ai:cancel` — sent when the
 * extension aborts its signal — stops that call. The ids live in this channel's own map: a
 * channel serves one generation, so an id from a dead generation finds nothing here.
 */
import type { RpcChannel } from "../extension-rpc.ts";
import type { ExtensionApiDeps } from "./index.ts";
import { OneShotError, oneShotCodeOf } from "../../providers/one-shot-error.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { CLAUDE_MODEL_IDS } from "../../types/claude-models.ts";
import { completeForExtension, defaultExtensionAiDeps, type ExtensionAiDeps } from "../extension-ai/extension-ai-complete.service.ts";
import { isExtensionId, type AiCompleteResult, type AiProviderId } from "../extension-ai/extension-ai-request.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("extension-ai");
const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The worker waits 30 s for `ai:listModels`; codex's own list is given 20 s of it. */
const CODEX_MODELS_TIMEOUT_MS = 20_000;

export interface AiWireError {
  code: string;
  message: string;
  raw?: string;
}

export type AiCompleteWire = { ok: true; result: AiCompleteResult } | { ok: false; error: AiWireError };

function toWire(error: unknown): AiWireError {
  const message = error instanceof Error ? error.message : String(error);
  const wire: AiWireError = { code: oneShotCodeOf(error), message };
  if (error instanceof OneShotError && error.raw !== undefined) wire.raw = error.raw;
  return wire;
}

function paramsOf(params: unknown[]): Record<string, unknown> {
  const first = params[0];
  return first && typeof first === "object" ? first as Record<string, unknown> : {};
}

function requireCall(p: Record<string, unknown>): { extensionId: string; callId: string } {
  if (!isExtensionId(p.extensionId)) throw new OneShotError("BAD_REQUEST", "extensionId must be an extension id");
  if (typeof p.callId !== "string" || !CALL_ID.test(p.callId)) throw new OneShotError("BAD_REQUEST", "callId must be a UUID");
  return { extensionId: p.extensionId, callId: p.callId };
}

/** Model ids per provider: Claude's from PPM's own list, Codex's from the app-server (cached). */
export async function listExtensionAiModels(
  codexModels: () => Promise<string[]> = async () => {
    const codex = providerRegistry.get("codex");
    return (await codex?.listModels?.() ?? []).map((m) => m.value);
  },
): Promise<Record<AiProviderId, string[]>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const codex = await Promise.race([
    codexModels().catch((e) => { log.warn(`codex model list failed: ${(e as Error)?.message ?? e}`); return []; }),
    new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve([]), CODEX_MODELS_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
  return { claude: [...CLAUDE_MODEL_IDS], codex };
}

export function registerExtensionAiHandlers(
  rpc: RpcChannel, deps: ExtensionApiDeps, ai: ExtensionAiDeps = defaultExtensionAiDeps,
): void {
  const running = new Map<string, { extensionId: string; controller: AbortController }>();

  rpc.onRequest("ai:complete", async (params): Promise<AiCompleteWire> => {
    let callId: string | null = null;
    try {
      const p = paramsOf(params);
      const ids = requireCall(p);
      if (running.has(ids.callId)) throw new OneShotError("BAD_REQUEST", "callId is already in use");
      callId = ids.callId;
      const call = deps.beginCall();
      const controller = new AbortController();
      const onEnd = () => controller.abort(call.signal.reason);
      if (call.signal.aborted) onEnd();
      else call.signal.addEventListener("abort", onEnd, { once: true });
      running.set(callId, { extensionId: ids.extensionId, controller });
      try {
        return { ok: true, result: await completeForExtension(ids.extensionId, p.request, controller.signal, ai) };
      } finally {
        call.signal.removeEventListener("abort", onEnd);
        call.end();
      }
    } catch (error) {
      return { ok: false, error: toWire(error) };
    } finally {
      if (callId) running.delete(callId);
    }
  });

  rpc.onRequest("ai:cancel", async (params) => {
    const p = paramsOf(params);
    const entry = typeof p.callId === "string" ? running.get(p.callId) : undefined;
    if (!entry || entry.extensionId !== p.extensionId) return { cancelled: false };
    entry.controller.abort(new OneShotError("ABORTED", "The extension cancelled the call"));
    return { cancelled: true };
  });

  rpc.onRequest("ai:listModels", async () => listExtensionAiModels());
}
