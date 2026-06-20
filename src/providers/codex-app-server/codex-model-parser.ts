import type { ModelOption } from "../provider.interface.ts";
import type { CodexModel } from "./codex-protocol.ts";

/**
 * Pure map of collected `model/list` data → ModelOption[].
 * Accepts the flattened `data[]` from all paginated pages. Hidden models are
 * dropped. Empty/malformed input → [] (FE falls back to config default model).
 */
export function parseModelList(models: unknown): ModelOption[] {
  if (!Array.isArray(models)) return [];
  const out: ModelOption[] = [];
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Partial<CodexModel>;
    if (m.hidden) continue;
    const value = typeof m.id === "string" ? m.id : undefined;
    if (!value) continue;
    const label = (typeof m.displayName === "string" && m.displayName) || value;
    out.push({ value, label });
  }
  return out;
}
