import type { ITheme } from "@xterm/xterm";
import type { PpmTheme } from "../types";

/**
 * Build an xterm ITheme from a PpmTheme. Uses the theme's explicit `terminal`
 * palette when present (imported themes); otherwise derives a sensible ANSI
 * palette from the semantic tokens + a neutral base per mode.
 */
export function buildXtermTheme(theme: PpmTheme): ITheme {
  const t = theme.tokens;

  if (theme.terminal) {
    const a = theme.terminal.ansi;
    return {
      background: t.bgSolid,
      foreground: t.text,
      cursor: theme.terminal.cursor,
      cursorAccent: theme.terminal.cursorAccent ?? t.bgSolid,
      selectionBackground: theme.terminal.selection,
      black: a[0], red: a[1], green: a[2], yellow: a[3],
      blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
      brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11],
      brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
    };
  }

  // Derived palette: semantic tokens drive the colored slots; neutrals per mode.
  const dark = theme.mode === "dark";
  const black = dark ? "#1b1f2a" : "#2b2f38";
  const white = dark ? "#d7dce8" : "#e9edf5";
  const brightBlack = t.text3;
  const brightWhite = dark ? "#f7f9ff" : "#ffffff";

  return {
    background: t.bgSolid,
    foreground: t.text,
    cursor: t.accent,
    cursorAccent: t.bgSolid,
    selectionBackground: t.accentWash,
    black,
    red: t.error,
    green: t.success,
    yellow: t.warning,
    blue: t.accent,
    magenta: t.accent2,
    cyan: t.info,
    white,
    brightBlack,
    brightRed: t.error,
    brightGreen: t.success,
    brightYellow: t.warning,
    brightBlue: t.accent,
    brightMagenta: t.accent2,
    brightCyan: t.info,
    brightWhite,
  } as ITheme;
}
