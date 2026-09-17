/**
 * The typing dots need an empty bubble to sit in.
 *
 * A streaming chat tab draws three bouncing dots inside its icon, Messenger
 * style. That was written against lucide's `MessageSquare`, which is a hollow
 * outline with nothing in it. Fluent's `chat` — what the icon migration mapped
 * that name to — draws **two message lines of its own** inside the bubble, and
 * the dots are absolutely positioned over the same 16px box in the same
 * `currentColor`. So they landed on top of the upper line and the three of them
 * fused into one lumpy bar: at 16px an indistinct smudge, and the bounce had
 * nothing legible left to move. It reads as a broken animation rather than a
 * mispicked glyph, which is why the fix is pinned here.
 *
 * `MessageCircle` is `chat-empty`: byte-identical bubble, no interior. The
 * structural assertion below is the one that matters — whatever glyph hosts the
 * dots must contribute nothing but the bubble, so a future MAP edit or a
 * regeneration that reintroduces a lined or filled glyph fails here instead of
 * shipping a smudge.
 *
 * Verified by rendering both glyphs with the animation frozen at 0/15/30/45/60%
 * of its cycle: `chat` barely changes shape across the five, `chat-empty` shows
 * three dots visibly rising and falling.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as icons from "../../../src/web/lib/icons.generated.tsx";

const root = resolve(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const tabBar = read("src/web/components/layout/draggable-tab.tsx");
const sheet = read("src/web/components/layout/mobile-tab-switcher-sheet.tsx");
const globals = read("src/web/styles/globals.css");

/** The `d` of every path a Fluent-backed icon draws. */
function pathsOf(name: keyof typeof icons): string[] {
  const Icon = icons[name] as unknown as {
    render: (p: object, ref: null) => { props: { children: { props: { d: string } }[] } };
  };
  const children = Icon.render({}, null).props.children;
  return children.map((c) => c.props.d);
}

/** Subpaths, i.e. how many separate shapes the glyph fills. */
function subpathCount(name: keyof typeof icons): number {
  return pathsOf(name)
    .flatMap((d) => d.split(/(?=[Mm])/))
    .filter((s) => s.trim() !== "").length;
}

describe("the glyph behind the typing dots is empty", () => {
  it("draws nothing but the bubble: an outer edge and its hole", () => {
    // Two subpaths and no more. A third is something *inside* the bubble, which
    // is exactly what collided with the dots.
    expect(subpathCount("MessageCircle")).toBe(2);
  });

  it("is the same bubble as the generic chat icon, not a different shape", () => {
    // A chat tab at rest wears its provider's logo (`provider-logos.tsx`) and
    // falls back to `MessageSquare` for a provider with no artwork. Those two
    // must be interchangeable at a glance, so `chat-empty` is `chat` minus its
    // contents and the outline subpaths are identical.
    const [empty, chat] = [pathsOf("MessageCircle"), pathsOf("MessageSquare")].map((ps) =>
      ps.flatMap((d) => d.split(/(?=[Mm])/)).filter((s) => s.trim() !== ""),
    );
    expect(empty).toHaveLength(2);
    expect(chat.slice(0, 2)).toEqual(empty);
  });

  it("records why the resting icon cannot host them", () => {
    // Not a tautology: if a future Fluent release emptied `chat`, this fails and
    // the swap can be reconsidered rather than kept for a reason gone stale.
    expect(subpathCount("MessageSquare")).toBeGreaterThan(2);
  });
});

describe("both tab surfaces swap to it while streaming", () => {
  for (const [label, src] of [
    ["draggable-tab.tsx", tabBar],
    ["mobile-tab-switcher-sheet.tsx", sheet],
  ] as const) {
    it(`${label} renders the empty bubble, not the tab's own icon`, () => {
      expect(src).toMatch(/import \{[^}]*\bMessageCircle\b[^}]*\} from "@\/lib\/icons"/);
      // The streaming branch must reach MessageCircle, and the resting one <Icon>.
      const streaming = /isStreaming \? \(?\s*<MessageCircle/.exec(src);
      expect(streaming, `${label}: streaming branch does not render MessageCircle`).not.toBeNull();
      expect(src).toMatch(/<Icon\s+className=/);
    });

    it(`${label} still stacks three dots on staggered delays`, () => {
      const dots = src.match(/tab-typing-dot/g) ?? [];
      expect(dots).toHaveLength(3);
      // Without the stagger all three move together, which is a blink, not typing.
      expect(src).toContain('animationDelay: "0.15s"');
      expect(src).toContain('animationDelay: "0.3s"');
    });
  }
});

describe("the animation itself", () => {
  it("bounces on a loop and is dropped for reduced motion", () => {
    expect(globals).toMatch(/@keyframes tabTypingBounce/);
    expect(globals).toMatch(/\.tab-typing-dot\s*\{[^}]*animation:\s*tabTypingBounce[^}]*infinite/);
    const reduced = globals.slice(globals.indexOf("@keyframes tabTypingBounce"));
    expect(reduced).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.tab-typing-dot\s*\{\s*animation:\s*none/,
    );
  });
});
