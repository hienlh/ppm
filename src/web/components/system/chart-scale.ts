/** Shared scale resolution for the canvas charts: a fixed ceiling (percentage axes)
 *  or autoscale to the max of the visible window (byte-rate axes) — pulled out of
 *  `metric-chart-canvas.tsx` so it is unit-testable without a canvas context. A
 *  percentage axis must be pinned to 100, otherwise a 3% CPU reading autoscales to a
 *  full-height line. */
export function resolveScaleMax(data: number[], maxValue?: number): number {
  if (maxValue !== undefined) return maxValue;
  return Math.max(...data, 1);
}

/** The minimal surface of `CSSStyleDeclaration` this needs — lets a test pass a plain
 *  fake object instead of a real computed style. */
export interface ComputedColorSource {
  getPropertyValue(property: string): string;
}

/** Canvas 2D's `strokeStyle`/`fillStyle` parse as a standalone CSS `<color>` — `var(...)`
 *  is not resolvable without an element context, so assigning `"var(--color-primary)"`
 *  directly is silently ignored and the shape draws black. Resolve once per draw call
 *  against the canvas's own computed style (custom properties inherit from the
 *  document, so any element's computed style works) and fall back to the original
 *  string when it is not a `var(...)` reference or resolves to nothing. */
export function resolveCssColor(color: string, styles: ComputedColorSource): string {
  const match = /^var\((--[\w-]+)\)$/.exec(color.trim());
  if (!match) return color;
  const resolved = styles.getPropertyValue(match[1]!).trim();
  return resolved || color;
}
