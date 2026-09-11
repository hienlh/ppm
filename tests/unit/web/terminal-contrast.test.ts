/**
 * Both ends of every ANSI palette collapse into the background, and the fix is
 * not in the palette.
 *
 * A terminal palette has sixteen slots and a background, and two of the slots
 * are *defined* to sit at the extremes — so on a light theme `white` and
 * `brightWhite` land on top of the background, and on a dark one `black` does.
 * Measured against PPM's own themes that is 1.03–1.18:1, which is not "low
 * contrast", it is invisible. It is not hypothetical either: oh-my-posh writes
 * its second prompt line in plain SGR 37, correct on the dark terminal it was
 * designed for, and that line simply was not there on a light PPM theme.
 *
 * Recolouring the slots cannot fix it, which is why this test asserts the
 * mitigation rather than a palette value: the same `white` is *also* the text
 * on a coloured powerline segment, where white is exactly right. Only a
 * per-cell adjustment can tell those two uses apart, and `minimumContrastRatio`
 * is xterm's — it leaves a cell alone once the ratio is met, so the segments
 * render identically and only the text with nothing behind it moves.
 *
 * Verified by rendering the real prompt into a real xterm on both themes: the
 * second line went from invisible to legible and every coloured segment was
 * unchanged.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_THEMES } from "../../../src/web/theme/builtin/index.ts";
import { buildXtermTheme } from "../../../src/web/theme/adapters/xterm-adapter.ts";

const useTerminal = readFileSync(
  resolve(import.meta.dir, "../../../src/web/hooks/use-terminal.ts"),
  "utf8",
);

/** Relative luminance, per WCAG. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const channel = (i: number) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const ANSI_SLOTS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

const themes = Object.entries(BUILTIN_THEMES).map(([id, theme]) => {
  const x = buildXtermTheme(theme) as unknown as Record<string, string>;
  return { id, mode: theme.mode, bg: x.background!, palette: x };
});

describe("the palette's neutral ends really do vanish", () => {
  it("has a slot under 1.5:1 in every built-in theme", () => {
    // The hazard this test exists for. If a future palette ever fixed it
    // outright this fails, and the assertion below can be reconsidered — but
    // it must be reconsidered, not silently kept passing for another reason.
    for (const { id, bg, palette } of themes) {
      const invisible = ANSI_SLOTS.filter((s) => contrast(palette[s]!, bg) < 1.5);
      expect(invisible.length, `${id}: nothing invisible?`).toBeGreaterThan(0);
    }
  });

  it("loses white on the light themes and black on the dark ones", () => {
    // Named, because which slot it is says what breaks: SGR 37 on light,
    // SGR 30 on dark. Both are ordinary things for a prompt to emit.
    for (const { id, mode, bg, palette } of themes) {
      const doomed = mode === "light" ? "white" : "black";
      expect(contrast(palette[doomed]!, bg), `${id} ${doomed}`).toBeLessThan(1.5);
    }
  });

  it("keeps the coloured slots usable, so only the neutrals are the problem", () => {
    // If red/green/yellow/blue were also collapsing, the palette itself would
    // be wrong and no per-cell trick would save it.
    for (const { id, bg, palette } of themes) {
      for (const slot of ["red", "green", "blue", "cyan"] as const) {
        expect(contrast(palette[slot]!, bg), `${id} ${slot}`).toBeGreaterThan(1.5);
      }
    }
  });
});

describe("the terminal mitigates it per cell", () => {
  it("asks xterm for a minimum contrast ratio", () => {
    const m = /minimumContrastRatio:\s*([\d.]+)/.exec(useTerminal);
    expect(m, "use-terminal.ts does not set minimumContrastRatio").not.toBeNull();
    // 1 is xterm's default and means "do nothing" — the state this fixed.
    expect(Number(m![1])).toBeGreaterThanOrEqual(4.5);
  });

  it("sets it on the Terminal itself, not on a renderer that may not be loaded", () => {
    // The WebGL addon is skipped on touch devices, which is exactly where the
    // bug was reported from — so the option has to be a terminal option.
    const ctor = useTerminal.slice(
      useTerminal.indexOf("new Terminal({"),
      useTerminal.indexOf("});", useTerminal.indexOf("new Terminal({")),
    );
    expect(ctor).toContain("minimumContrastRatio");
  });
});
