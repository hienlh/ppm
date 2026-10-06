import { useState, useEffect, useMemo } from "react";
import type { Theme } from "@glideapps/glide-data-grid";
import { flattenColor } from "@/lib/color-utils";
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
  // Surface tokens are translucent in several themes; the grid paints them as
  // canvas fills, which must be opaque to erase the previous frame.
  const muted = flattenColor(cssVar("--color-muted"), bg);
  const mutedFg = cssVar("--color-muted-foreground");
  const primary = cssVar("--color-primary");
  const primaryFg = cssVar("--color-primary-foreground");
  const border = cssVar("--color-border");
  // Brand accent for focus/hover highlights (shadcn `--color-accent` is a hover surface).
  const accent = cssVar("--color-primary");
  const textSecondary = cssVar("--color-text-secondary");
  const textSubtle = cssVar("--color-text-subtle");
  const fontSans = cssVar("--font-sans") || "Geist, system-ui, sans-serif";
  // The header of the column holding the current cell, and of the one under the pointer. Its title
  // keeps the ink it has on the plain header, so this is a tint and not the accent: on the accent a
  // nullable column's name measured 1.0–1.6:1 and the sort arrow, drawn in the accent, vanished. A
  // whole selected column is still filled with the accent, and its title drawn in `accentFg`.
  const headerTint = flattenColor(withAlpha(primary, 0.08), muted);

  return {
    bgCell: bg,
    bgCellMedium: muted,
    bgHeader: muted,
    bgHeaderHasFocus: headerTint,
    bgHeaderHovered: headerTint,
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
 * What the grid draws pending changes with, as DBGate does: an edited cell yellow with a bar at its
 * left, a new row green, a row to be deleted red and struck through. Washes of the theme's own
 * status colours, made opaque over the cell background as canvas fills must be.
 */
export interface GridChangeColors {
  edited: string;
  editedBar: string;
  inserted: string;
  /** A new row's number. */
  insertedMark: string;
  deleted: string;
  deletedText: string;
  deletedStrike: string;
  /** A deleted row's number. */
  deletedMark: string;
}

function buildChangeColors(): GridChangeColors {
  const bg = cssVar("--color-background");
  const warning = cssVar("--color-warning");
  const success = cssVar("--color-success");
  const error = cssVar("--color-error");
  // A colour that is not #rrggbb cannot be washed out here, and drawn whole it would bury the text.
  const wash = (color: string, alpha: number) => (/^#[0-9a-f]{6}$/i.test(color) ? flattenColor(withAlpha(color, alpha), bg) : bg);
  return {
    edited: wash(warning, 0.17),
    editedBar: warning,
    inserted: wash(success, 0.14),
    insertedMark: success,
    deleted: wash(error, 0.13),
    deletedText: cssVar("--color-text-subtle"),
    deletedStrike: withAlpha(error, 0.7),
    deletedMark: error,
  };
}

/** The change colours of `theme`, built again whenever the grid's theme is. */
export function useGridChangeColors(theme: Partial<Theme>): GridChangeColors {
  return useMemo(() => buildChangeColors(), [theme]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Hook that returns a Glide Data Grid theme synced to PPM's dark/light mode.
 * Watches <html> class changes via MutationObserver to rebuild on theme toggle.
 */
export function useGlideTheme(): Partial<Theme> {
  // Bump counter on theme class change to trigger rebuild
  const [rev, setRev] = useState(0);

  useEffect(() => {
    const bump = () => setRev((r) => r + 1);
    // Class toggles cover dark↔light; the theme-change event covers same-mode
    // style swaps (e.g. aurora-dark → slate-dark) where the class doesn't change.
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("ppm:theme-change", bump);
    return () => {
      observer.disconnect();
      window.removeEventListener("ppm:theme-change", bump);
    };
  }, []);

  return useMemo(() => buildTheme(), [rev]); // eslint-disable-line react-hooks/exhaustive-deps
}
