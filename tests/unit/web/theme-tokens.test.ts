import { describe, expect, it } from "bun:test";
import { TOKEN_KEYS, tokenToCssVar } from "../../../src/web/theme/tokens";
import { BUILTIN_THEMES, BUILTIN_ORDER } from "../../../src/web/theme/builtin";

/**
 * Guards the invariant that a token key's CSS var name stays in lockstep with
 * globals.css `:root` / `@theme inline`. A mismatch here means themes silently
 * fail to apply, so any token rename must update this map deliberately.
 */
const EXPECTED_VARS: Record<string, string> = {
  bg: "--bg",
  bgSolid: "--bg-solid",
  rail: "--rail",
  panel: "--panel",
  panel2: "--panel-2",
  border: "--border",
  borderSoft: "--border-soft",
  text: "--text",
  text2: "--text-2",
  text3: "--text-3",
  accent: "--accent",
  accentFg: "--accent-fg",
  accent2: "--accent-2",
  accentWash: "--accent-wash",
  accentWashBorder: "--accent-wash-border",
  success: "--success",
  warning: "--warning",
  error: "--error",
  info: "--info",
  shadowPanel: "--shadow-panel",
  shadowFloat: "--shadow-float",
  rad: "--rad",
  radSm: "--rad-sm",
  blur: "--blur",
};

describe("tokenToCssVar", () => {
  it("maps every token key to the expected CSS var name", () => {
    for (const key of TOKEN_KEYS) {
      expect(tokenToCssVar(key)).toBe(EXPECTED_VARS[key]);
    }
  });

  it("TOKEN_KEYS and EXPECTED_VARS cover the same keys", () => {
    expect(TOKEN_KEYS.slice().sort()).toEqual(Object.keys(EXPECTED_VARS).sort());
  });
});

describe("built-in themes", () => {
  it("exposes all 6 themes in the picker order", () => {
    expect(BUILTIN_ORDER).toHaveLength(6);
    for (const id of BUILTIN_ORDER) {
      expect(BUILTIN_THEMES[id]).toBeDefined();
    }
  });

  it("every theme defines all token keys", () => {
    for (const id of BUILTIN_ORDER) {
      const theme = BUILTIN_THEMES[id]!;
      for (const key of TOKEN_KEYS) {
        expect(theme.tokens[key], `${id}.${key}`).toBeTruthy();
      }
      expect(theme.swatch).toHaveLength(3);
      expect(theme.id).toBe(id);
    }
  });
});
