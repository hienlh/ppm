/** Parse hex color to RGB components */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Parse hex / rgb() / rgba() into RGBA components */
function parseCssColor(color: string): { r: number; g: number; b: number; a: number } | null {
  const c = color.trim();
  if (c.startsWith("#")) {
    const hex = c.slice(1);
    const full = hex.length === 3 ? hex.split("").map((h) => h + h).join("") : hex;
    if (!/^[0-9a-fA-F]{6,8}$/.test(full)) return null;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
    };
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (!m) return null;
  const parts = m[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 4).some((n) => Number.isNaN(n))) return null;
  return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
}

/**
 * Composite a translucent color onto an opaque backdrop.
 * Canvas fills don't blend with the DOM behind them, so a translucent surface
 * color leaves whatever was painted before still visible.
 * Returns the input unchanged when it is already opaque or cannot be parsed.
 */
export function flattenColor(color: string, backdrop: string): string {
  const fg = parseCssColor(color);
  const bg = parseCssColor(backdrop);
  if (!fg || !bg || fg.a >= 1) return color;
  const mix = (f: number, b: number) => Math.round(f * fg.a + b * (1 - fg.a));
  return `rgb(${mix(fg.r, bg.r)}, ${mix(fg.g, bg.g)}, ${mix(fg.b, bg.b)})`;
}

/** Relative luminance per WCAG 2.0 */
function getLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** Returns true if the color is dark enough to need white text */
export function isDarkColor(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  return getLuminance(rgb.r, rgb.g, rgb.b) < 0.4;
}
