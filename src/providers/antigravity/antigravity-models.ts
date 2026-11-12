import type { ModelOption } from "../provider.interface.ts";
import { discoverLanguageServerConnection } from "./antigravity-connection.ts";
import { getConfigValue, setConfigValue } from "../../services/db.service.ts";
import { createLogger } from "../../services/logger.ts";

const log = createLogger("antigravity");

export const ANTIGRAVITY_DEFAULT_EFFORT = "high";

/**
 * The models agy last reported, as one config row outside `CONFIG_TABLE_KEYS`. agy lists them
 * (and the one it would use) only in its answer to `session/new` or `session/load`, and asking
 * for that without a chat leaves an empty conversation in its store. Kept here, the picker has
 * agy's own list while the Antigravity app is closed, and no model name is written into PPM.
 */
const MODELS_KEY = "antigravity_models";

export interface AgyModels {
  /** agy's model ids, effort included (`gemini-4-carbon-high`), with their names. */
  available: { modelId: string; name: string }[];
  /** The model agy picks for a new chat. */
  current?: string;
}

/** The usable part of a `models` object from `session/new` / `session/load`, or of the stored copy. */
export function parseAgyModels(raw: unknown): AgyModels | null {
  const r = raw as { availableModels?: unknown; available?: unknown; currentModelId?: unknown; current?: unknown } | null;
  const list = Array.isArray(r?.availableModels) ? r.availableModels : Array.isArray(r?.available) ? r.available : [];
  const available = list.flatMap((m) => {
    const e = m as { modelId?: unknown; name?: unknown };
    return typeof e?.modelId === "string" && e.modelId ? [{ modelId: e.modelId, name: typeof e.name === "string" && e.name ? e.name : e.modelId }] : [];
  });
  if (available.length === 0) return null;
  const current = typeof r?.currentModelId === "string" ? r.currentModelId : typeof r?.current === "string" ? r.current : undefined;
  return { available, ...(current ? { current } : {}) };
}

/** Keep what agy reported when it opened a new chat; written only when it changed. */
export function rememberAgyModels(raw: unknown): void {
  const models = parseAgyModels(raw);
  if (!models) return;
  try {
    const next = JSON.stringify(models);
    if (getConfigValue(MODELS_KEY) !== next) setConfigValue(MODELS_KEY, next);
  } catch (err) {
    log.warn(`could not keep agy's model list: ${(err as Error).message}`);
  }
}

/** What agy last reported, or null while it has never opened a chat here. */
export function storedAgyModels(): AgyModels | null {
  try {
    return parseAgyModels(JSON.parse(getConfigValue(MODELS_KEY) ?? "null"));
  } catch {
    return null;
  }
}

/** agy's models as picker options, one per model (effort is picked separately), agy's own first pick marked. */
export function agyModelOptions(models: AgyModels | null): ModelOption[] {
  if (!models) return [];
  const defaultBase = models.current ? toAntigravityBaseModelId(models.current) : undefined;
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const m of models.available) {
    const value = toAntigravityBaseModelId(m.modelId);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label: toAntigravityBaseModelLabel(m.name), ...(value === defaultBase ? { isDefault: true } : {}) });
  }
  return out;
}

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
 * Resolve `(model, effort)` into the concrete Antigravity `modelId` sent with `session/set_model`,
 * against agy's own list: `("gemini-4-carbon", "high")` -> `"gemini-4-carbon-high"`, and a model
 * with fewer efforts gets the one it has (`gpt-oss-120b` -> `gpt-oss-120b-medium`).
 * No model chosen ("Auto") means agy's: `current`, at the chosen effort. Null when there is
 * nothing to ask for, i.e. no choice and agy named no model: the chat keeps agy's.
 */
export function resolveAntigravityModelId(
  model?: string | null,
  effort?: string | null,
  agy?: { available?: string[]; current?: string },
): string | null {
  const chosen = model && model !== "__default__" && model !== "pro" ? model.trim() : undefined;
  if (chosen === "flash" || chosen === "flash_lite") return chosen;
  const from = chosen ?? agy?.current;
  if (!from) return null;

  const base = toAntigravityBaseModelId(from);
  const suffix = /-(low|medium|high)$/i.exec(chosen ?? "")?.[1];
  const rawEffort = (effort || suffix || ANTIGRAVITY_DEFAULT_EFFORT).toLowerCase();
  const wanted = `${base}-${rawEffort === "low" || rawEffort === "medium" ? rawEffort : "high"}`;
  const available = agy?.available ?? [];
  if (available.length === 0 || available.includes(wanted)) return wanted;
  if (available.includes(base)) return base;
  return available.find((id) => toAntigravityBaseModelId(id) === base) ?? wanted;
}

/**
 * Parse Antigravity's `GetCascadeModelConfigData` response into deduplicated base `ModelOption[]`
 * (e.g. `Gemini 4 Carbon`, `Gemini 4 Argon`, `Gemini 3.8 Flash`, `Claude Opus 5.5`, `Claude Sonnet 5.5`, `GPT-OSS 120B`),
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
 * falling back to the list agy last reported while the app is closed. The model agy picks for a
 * new chat is marked either way, from what agy reported.
 */
export async function fetchAntigravityModelsLive(customHome?: string): Promise<ModelOption[]> {
  const stored = storedAgyModels();
  const fromAgy = agyModelOptions(stored);
  const fromApp = await fetchLanguageServerModels(customHome);
  if (fromApp.length === 0) return fromAgy;
  const defaultBase = stored?.current ? toAntigravityBaseModelId(stored.current) : undefined;
  return fromApp.map((m) => (m.value === defaultBase ? { ...m, isDefault: true } : m));
}

async function fetchLanguageServerModels(customHome?: string): Promise<ModelOption[]> {
  const conn = discoverLanguageServerConnection(customHome);
  if (!conn) return [];

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
    if (!res.ok) return [];
    return parseAntigravityModels((await res.json()) as GetCascadeModelConfigDataRaw);
  } catch {
    return [];
  }
}
