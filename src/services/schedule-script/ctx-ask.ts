/**
 * `ctx.ai.ask(prompt, opts)`: one question, one answer, through `completeOnce` — Claude's with
 * PPM's account rotation, or the mock provider's free answer when the schedule runs on `mock`.
 * A failed answer is a result with `ok: false`, never a throw: the script decides what then.
 */
import { providerRegistry } from "../../providers/registry.ts";
import type { Schedule } from "../../types/scheduler.ts";

export const ASK_DEFAULT_MODEL = "haiku";
export const ASK_DEFAULT_TIMEOUT_MS = 120_000;

export interface AskOptions {
  model?: string;
  system?: string;
  effort?: "low" | "medium" | "high";
  jsonSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface AskResult {
  ok: boolean;
  text: string;
  json?: unknown;
  costUsd?: number;
  timedOut?: boolean;
  error?: string;
}

type CompleteOnce = (input: {
  prompt: string; model: string; systemPrompt?: string; effort?: AskOptions["effort"];
  jsonSchema?: Record<string, unknown>; timeoutMs?: number;
}) => Promise<{ text: string; json?: unknown; costUsd: number }>;

export async function scheduleAsk(schedule: Pick<Schedule, "provider_id">, prompt: string, opts: AskOptions): Promise<AskResult> {
  const providerId = schedule.provider_id === "mock" ? "mock" : "claude";
  const provider = providerRegistry.get(providerId) as { completeOnce?: CompleteOnce } | undefined;
  if (typeof provider?.completeOnce !== "function") {
    return { ok: false, text: "", error: `The ${providerId} provider is not available` };
  }
  const timeoutMs = opts.timeoutMs ?? ASK_DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  try {
    const answer = await provider.completeOnce({
      prompt,
      model: opts.model ?? ASK_DEFAULT_MODEL,
      ...(opts.system !== undefined && { systemPrompt: opts.system }),
      ...(opts.effort && { effort: opts.effort }),
      ...(opts.jsonSchema && { jsonSchema: opts.jsonSchema }),
      timeoutMs,
    });
    return { ok: true, text: answer.text, ...(answer.json !== undefined && { json: answer.json }), costUsd: answer.costUsd };
  } catch (e) {
    return {
      ok: false, text: "", error: (e as Error).message,
      ...(Date.now() - started >= timeoutMs && { timedOut: true }),
    };
  }
}
