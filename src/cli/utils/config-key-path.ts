/**
 * Dotted config keys (`ai.providers.claude.model`): reading, writing and typing one value. Shared
 * by `ppm config` and the server's `PUT /api/settings/config-key`, so a value typed on the command
 * line means the same thing whichever of the two writes it.
 */
export type FlatConfig = Record<string, string | number | boolean>;
export type ConfigValueType = "string" | "number" | "boolean";

export function flattenConfig(obj: unknown, prefix = ""): FlatConfig {
  const result: FlatConfig = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) Object.assign(result, flattenConfig(v, key));
    else result[key] = v as string | number | boolean;
  }
  return result;
}

export function getNestedValue(obj: unknown, keyPath: string): unknown {
  let current: unknown = obj;
  for (const part of keyPath.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Sets `keyPath` in `obj` to `value` as given, creating objects on the way. */
export function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const parts = keyPath.split(".");
  let current = obj;
  for (const part of parts.slice(0, -1)) {
    if (typeof current[part] !== "object" || current[part] === null) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

/**
 * `raw` as the type the key already holds (`"9090"` → 9090 for `port`), or `declared` when the key
 * is unset. An object or a list is never replaced by one typed value.
 */
export function coerceConfigValue(existing: unknown, raw: unknown, declared?: ConfigValueType): { value: string | number | boolean } | { error: string } {
  const type: string | undefined = existing === undefined || existing === null ? declared : typeof existing;
  if (type === "object" || Array.isArray(existing)) return { error: "holds a group of settings, not one value; set one of its keys" };
  if (type === "number") {
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    return Number.isFinite(n) ? { value: n } : { error: `expects a number, got "${String(raw)}"` };
  }
  if (type === "boolean") {
    if (raw === true || raw === "true" || raw === "1") return { value: true };
    if (raw === false || raw === "false" || raw === "0") return { value: false };
    return { error: `expects true or false, got "${String(raw)}"` };
  }
  if (type === "string") return { value: String(raw) };
  return { error: "is not a setting" };
}
