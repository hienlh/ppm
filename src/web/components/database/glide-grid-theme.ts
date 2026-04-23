import { useState, useEffect, useMemo } from "react";
import type { Theme } from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";

/** Read a CSS custom property from :root */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Add alpha channel to a hex/rgb color string */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

/** Build Glide theme from current CSS variables */
function buildTheme(): Partial<Theme> {
  const bg = cssVar("--color-background");
  const fg = cssVar("--color-foreground");
  const muted = cssVar("--color-muted");
  const mutedFg = cssVar("--color-muted-foreground");
  const primary = cssVar("--color-primary");
  const primaryFg = cssVar("--color-primary-foreground");
  const border = cssVar("--color-border");
  const accent = cssVar("--color-accent");
  const textSecondary = cssVar("--color-text-secondary");
  const textSubtle = cssVar("--color-text-subtle");
  const fontSans = cssVar("--font-sans") || "Geist, system-ui, sans-serif";

  return {
    bgCell: bg,
    bgCellMedium: muted,
    bgHeader: muted,
    bgHeaderHasFocus: accent,
    bgHeaderHovered: accent,
    bgBubble: accent,
    bgBubbleSelected: primary,
    textDark: fg,
    textMedium: textSecondary,
    textLight: textSubtle,
    textHeader: mutedFg,
    textGroupHeader: mutedFg,
    textHeaderSelected: fg,
    textBubble: fg,
    accentColor: primary,
    accentFg: primaryFg,
    accentLight: withAlpha(primary, 0.12),
    borderColor: border,
    horizontalBorderColor: border,
    fontFamily: fontSans,
    baseFontStyle: "13px",
    headerFontStyle: "600 12px",
    editorFontSize: "13px",
    lineHeight: 1.5,
    cellHorizontalPadding: 8,
    cellVerticalPadding: 4,
    headerIconSize: 16,
  };
}

/**
 * Hook that returns a Glide Data Grid theme synced to PPM's dark/light mode.
 * Watches <html> class changes via MutationObserver to rebuild on theme toggle.
 */
export function useGlideTheme(): Partial<Theme> {
  // Bump counter on theme class change to trigger rebuild
  const [rev, setRev] = useState(0);

  useEffect(() => {
    const observer = new MutationObserver(() => setRev((r) => r + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return useMemo(() => buildTheme(), [rev]); // eslint-disable-line react-hooks/exhaustive-deps
}
