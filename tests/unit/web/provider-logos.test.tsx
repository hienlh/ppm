/**
 * Two ways a provider logo fails without saying anything, and one wiring rule.
 *
 * The colour marks carry gradients, and a gradient is reached by id. Two copies
 * of one logo would declare the same id, `url(#id)` resolves against the *first*
 * such element in the document, and a gradient sitting in a `display: none`
 * subtree paints nothing — so one chat tab open in the background is enough to
 * blank every other Codex or Gemini mark on the page. Nothing errors; the boxes
 * are simply empty. Hence a fresh id per instance, asserted here rather than
 * trusted.
 *
 * The other one is the Codex *colour* file, which is an app tile: a white
 * rounded square with the mark inset. Vendored as-is it is a white patch in
 * every dark theme, and it looks perfectly correct in a light one — so it is a
 * bug only half the users can see.
 */
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PROVIDER_LOGOS,
  ClaudeLogo,
  CodexLogo,
  CursorLogo,
  GeminiLogo,
} from "../../../src/web/lib/provider-logos.tsx";
import { getTabIcon, TAB_TYPE_ICONS } from "../../../src/web/lib/tab-type-icons.ts";

/** Each `<svg>` of a rendered tree as its own string. */
function svgs(html: string): string[] {
  return [...html.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => m[0]);
}

describe("a gradient id belongs to exactly one instance", () => {
  for (const [name, Logo] of [["codex", CodexLogo], ["gemini", GeminiLogo]] as const) {
    it(`${name}: two copies on a page share no id`, () => {
      const copies = svgs(renderToStaticMarkup(<><Logo /><Logo /></>));
      expect(copies).toHaveLength(2);
      const declared = copies.map((s) => [...s.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));
      expect(declared[0]!.length).toBeGreaterThan(0);
      expect(declared[0]!.filter((id) => declared[1]!.includes(id))).toEqual([]);
    });

    it(`${name}: every url(#…) resolves inside its own svg`, () => {
      for (const copy of svgs(renderToStaticMarkup(<><Logo /><Logo /></>))) {
        const refs = [...copy.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]!);
        expect(refs.length).toBeGreaterThan(0);
        for (const ref of refs) expect(copy).toContain(`id="${ref}"`);
      }
    });
  }
});

describe("no logo paints a background behind itself", () => {
  for (const [id, Logo] of Object.entries(PROVIDER_LOGOS)) {
    it(`${id} carries no white tile to punch a hole in a dark theme`, () => {
      const html = renderToStaticMarkup(<Logo />);
      expect(html).toContain("<path");
      expect(html).not.toMatch(/fill="(#fff(?:fff)?|white)"/i);
    });
  }
});

describe("a chat tab is labelled with the provider running it", () => {
  const chat = (providerId?: string) => ({
    type: "chat" as const,
    title: "Chat",
    ...(providerId && { metadata: { providerId } }),
  });

  it("uses that provider's logo", () => {
    expect(getTabIcon(chat("codex"))).toBe(CodexLogo);
    expect(getTabIcon(chat("cursor"))).toBe(CursorLogo);
  });

  it("draws a chat carrying no provider as Claude, which is what it would run", () => {
    // `ChatTab` itself falls back to claude, so anything else would be a lie.
    expect(getTabIcon(chat())).toBe(ClaudeLogo);
  });

  it("falls back to the generic bubble for a provider with no artwork", () => {
    // `mock` is registered for real, and a new provider arrives the same way.
    expect(getTabIcon(chat("mock"))).toBe(TAB_TYPE_ICONS.chat);
  });

  it("covers every provider the registry can hand out", () => {
    for (const id of ["claude", "codex", "cursor"]) expect(PROVIDER_LOGOS[id]).toBeDefined();
  });
});
