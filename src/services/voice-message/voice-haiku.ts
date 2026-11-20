/**
 * The one model call voice messages make: Claude Haiku through the Claude provider's
 * `completeOnce` — the user's own Claude account, no tools, no project. Callers take the ask as a
 * parameter so tests can answer it themselves.
 */
import { LOGS_AI_MODEL } from "../logs/log-ai.ts";

/** One question to a model, answered as text. */
export type VoiceAsk = (input: { systemPrompt: string; prompt: string; timeoutMs: number }) => Promise<string>;

export const askClaudeHaiku: VoiceAsk = async ({ systemPrompt, prompt, timeoutMs }) => {
  const { providerRegistry } = await import("../../providers/registry.ts");
  const provider = providerRegistry.get("claude") as unknown as {
    completeOnce?: (input: { prompt: string; systemPrompt: string; model: string; timeoutMs?: number }) => Promise<{ text: string }>;
  } | undefined;
  if (typeof provider?.completeOnce !== "function") throw new Error("No Claude account is available for the clean-up");
  return (await provider.completeOnce({ prompt, systemPrompt, model: LOGS_AI_MODEL, timeoutMs })).text;
};

/** `work`, or a rejection once `ms` have passed without an answer. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Claude Haiku did not answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
