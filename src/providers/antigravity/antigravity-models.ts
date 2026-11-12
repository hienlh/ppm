import type { ModelOption } from "../provider.interface.ts";
import { discoverLanguageServerConnection } from "./antigravity-connection.ts";

export const ANTIGRAVITY_DEFAULT_MODEL = "gemini-4-argon";
export const ANTIGRAVITY_DEFAULT_EFFORT = "high";

export const ANTIGRAVITY_FALLBACK_MODELS: ModelOption[] = [
  { value: "gemini-4-argon", label: "Gemini 4 Argon" },
  { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { value: "gpt-oss-120b", label: "GPT-OSS 120B" },
];

export interface CascadeClientModelConfigRaw {
  label?: string;
  modelId?: string;
  modelOrAlias?: {
    model?: string;
    alias?: string;
  };
  tagTitle?: string;
}

export interface GetCascadeModelConfigDataRaw {
  clientModelConfigs?: CascadeClientModelConfigRaw[];
  clientModelSorts?: Array<{
    name?: string;
    groups?: Array<{
      modelLabels?: string[];
    }>;
  }>;
}

/** Strip trailing `-(low|medium|high)` from an Antigravity model ID. */
export function toAntigravityBaseModelId(id: string): string {
  return id.replace(/-(low|medium|high)$/i, "");
}

/** Strip trailing ` (Low|Medium|High)` from an Antigravity model display label. */
export function toAntigravityBaseModelLabel(label: string): string {
  return label.replace(/\s*\((low|medium|high)\)\s*$/i, "").trim();
}

/**
 * Resolve `(model, effort)` into the concrete Antigravity `modelId` sent with `session/set_model`.
 * Example: `("gemini-4-argon", "high")` -> `"gemini-4-argon-high"`.
 */
export function resolveAntigravityModelId(model?: string | null, effort?: string | null): string {
  const rawModel = model && model !== "__default__" && model !== "pro" ? model.trim() : ANTIGRAVITY_DEFAULT_MODEL;
  if (rawModel === "flash" || rawModel === "flash_lite") return rawModel;

  const suffixMatch = /-(low|medium|high)$/i.exec(rawModel);
  const baseModel = toAntigravityBaseModelId(rawModel);
  if (baseModel === "gpt-oss-120b") return "gpt-oss-120b-medium";

  const rawEffort = (effort || suffixMatch?.[1] || ANTIGRAVITY_DEFAULT_EFFORT).toLowerCase();
  const normalizedEffort = rawEffort === "low" || rawEffort === "medium" ? rawEffort : "high";
  return `${baseModel}-${normalizedEffort}`;
}

/**
 * Parse Antigravity's `GetCascadeModelConfigData` response into deduplicated base `ModelOption[]`
 * (e.g. `Gemini 4 Argon`, `Gemini 3.8 Flash`, `Claude Opus 5.5`, `Claude Sonnet 5.5`, `GPT-OSS 120B`),
 * since effort (`Low` / `Medium` / `High`) is selected in the Effort column of `ModelThinkingSelector`.
 */
export function parseAntigravityModels(raw: GetCascadeModelConfigDataRaw | null | undefined): ModelOption[] {
  const configs = raw?.clientModelConfigs ?? [];
  if (configs.length === 0) return [];

  const byRawLabel = new Map<string, ModelOption>();
  const allBaseOptions: ModelOption[] = [];
  const seenBase = new Set<string>();

  for (const cfg of configs) {
    const rawLabel = cfg.label?.trim();
    const rawValue = (cfg.modelId || cfg.modelOrAlias?.model || cfg.modelOrAlias?.alias)?.trim();
    if (!rawLabel || !rawValue) continue;
    const value = toAntigravityBaseModelId(rawValue);
    const label = toAntigravityBaseModelLabel(rawLabel);
    const option: ModelOption = { value, label };
    byRawLabel.set(rawLabel, option);
    if (!seenBase.has(value)) {
      seenBase.add(value);
      allBaseOptions.push(option);
    }
  }

  if (allBaseOptions.length === 0) return [];

  const orderedLabels = raw?.clientModelSorts?.[0]?.groups?.flatMap((g) => g.modelLabels ?? []) ?? [];
  if (orderedLabels.length === 0) return allBaseOptions;

  const sortedSeen = new Set<string>();
  const sorted: ModelOption[] = [];
  for (const rawLabel of orderedLabels) {
    const opt = byRawLabel.get(rawLabel);
    if (opt && !sortedSeen.has(opt.value)) {
      sortedSeen.add(opt.value);
      sorted.push(opt);
    }
  }
  for (const opt of allBaseOptions) {
    if (!sortedSeen.has(opt.value)) {
      sortedSeen.add(opt.value);
      sorted.push(opt);
    }
  }
  return sorted;
}

/**
 * Query Antigravity's local Language Server for the live model list (`GetCascadeModelConfigData`),
 * falling back to `ANTIGRAVITY_FALLBACK_MODELS` when offline.
 */
export async function fetchAntigravityModelsLive(customHome?: string): Promise<ModelOption[]> {
  const conn = discoverLanguageServerConnection(customHome);
  if (!conn) return ANTIGRAVITY_FALLBACK_MODELS;

  try {
    const res = await fetch(
      `http://${conn.address}/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": conn.csrfToken,
        },
        body: "{}",
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!res.ok) return ANTIGRAVITY_FALLBACK_MODELS;
    const raw = (await res.json()) as GetCascadeModelConfigDataRaw;
    const parsed = parseAntigravityModels(raw);
    return parsed.length > 0 ? parsed : ANTIGRAVITY_FALLBACK_MODELS;
  } catch {
    return ANTIGRAVITY_FALLBACK_MODELS;
  }
}
