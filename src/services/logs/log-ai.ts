/**
 * The one AI call the Logs window makes, two ways: sorting errors into issues and drafting a
 * report. Claude Haiku, on the person's own Claude account, with no tools and no project
 * (`ClaudeAgentSdkProvider.completeOnce`). Callers redact what they send.
 */
export const LOGS_AI_MODEL = "claude-haiku-4-5";
export const LOGS_AI_MODEL_NAME = "Claude Haiku 4.5";

interface OneShotProvider {
  completeOnce(input: { prompt: string; systemPrompt: string; model: string; timeoutMs?: number }): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

/** Imported on first use, so loading the Logs modules (and their tests) does not load every provider. */
async function claude(): Promise<OneShotProvider> {
  const { providerRegistry } = await import("../../providers/registry.ts");
  const p = providerRegistry.get("claude") as unknown as Partial<OneShotProvider> | undefined;
  if (!p || typeof p.completeOnce !== "function") throw new Error("The Claude provider is not available");
  return p as OneShotProvider;
}

export type AskFn = (systemPrompt: string, prompt: string) => Promise<{ text: string; tokens: number }>;

/** The real call; tests pass their own `AskFn` instead. */
export const askClaude: AskFn = async (systemPrompt, prompt) => {
  const r = await (await claude()).completeOnce({ prompt, systemPrompt, model: LOGS_AI_MODEL, timeoutMs: 120_000 });
  return { text: r.text, tokens: r.inputTokens + r.outputTokens };
};

/** The JSON object in an answer, which may come wrapped in a code fence or a sentence. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The answer held no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

export function clip(text: unknown, max: number): string {
  const s = typeof text === "string" ? text.trim() : "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
