// Pure helpers for the unified model + thinking picker. Kept DOM-free so the
// label↔value mapping (the crash-prone "Extra"→"xhigh" contract) is unit-testable
// without a browser harness.
//
// SDK effort enum = low | medium | high | xhigh | max. The app UI shows "Extra"
// for the SDK value "xhigh"; the literal "extra" would crash the CLI subprocess,
// so it must NEVER appear as a value here.

export interface EffortOption {
  label: string;
  value: "low" | "medium" | "high" | "xhigh" | "max";
  default?: boolean;
}

export const EFFORT_OPTIONS: EffortOption[] = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high", default: true },
  { label: "Extra", value: "xhigh" },
  { label: "Max", value: "max" },
];

/** UI label for an effort value; falls back to the raw value when unknown. */
export function effortLabel(value: string | null | undefined): string {
  if (!value) return "";
  return EFFORT_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/** Chip text: model display, plus " · <Effort>" when an effort is set. */
export function chipLabel(modelDisplay: string, effortValue: string | null | undefined): string {
  const eff = effortLabel(effortValue);
  return eff ? `${modelDisplay} · ${eff}` : modelDisplay;
}
