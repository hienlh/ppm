/**
 * Where a chat's message list scrolls so one element can be read above the footer: a card that
 * fits is landed whole, a taller one shows its end (its buttons) just above the footer, and an
 * element opened in place moves the list only as far as its end needs, never past its own top.
 */
import { describe, expect, it } from "bun:test";
import { BOTTOM_GAP, TOP_GAP, revealTarget } from "../../../src/web/lib/reveal-in-scroll-list";

// A 600 px list at the top of the screen, scrolled 1000 px down.
const list = { top: 0, height: 600, scrollTop: 1000 };

describe("revealTarget", () => {
  it("lands a card that fits with its top just under the list's top, so all of it shows", () => {
    const to = revealTarget({ top: 900, height: 300 }, list, "land")!;
    expect(to).toBe(1000 + 900 - TOP_GAP);
    // After the scroll the card's end is above the footer's strip.
    expect(900 - (to - 1000) + 300).toBeLessThanOrEqual(600 - BOTTOM_GAP);
  });

  it("lands a card that fits only without the top gap flush with the list's top", () => {
    const to = revealTarget({ top: 900, height: 600 - BOTTOM_GAP - 4 }, list, "land")!;
    expect(to).toBe(1000 + 900);
  });

  it("lands a card taller than the list with its end just above the footer", () => {
    const to = revealTarget({ top: 900, height: 1200 }, list, "land")!;
    expect(900 - (to - 1000) + 1200).toBe(600 - BOTTOM_GAP);
  });

  it("keeps a tall card's end above the message navigator when it floats higher than the fade", () => {
    const to = revealTarget({ top: 900, height: 1200 }, list, "land", 76)!;
    expect(900 - (to - 1000) + 1200).toBe(600 - 76);
  });

  it("never scrolls above the list's start", () => {
    expect(revealTarget({ top: -2000, height: 100 }, list, "land")).toBe(0);
  });

  it("leaves the list alone when an opened element already shows whole", () => {
    expect(revealTarget({ top: 100, height: 300 }, list, "reveal")).toBeNull();
  });

  it("moves just far enough to show an opened element's end above the footer", () => {
    const to = revealTarget({ top: 400, height: 300 }, list, "reveal")!;
    expect(400 - (to - 1000) + 300).toBe(600 - BOTTOM_GAP);
  });

  it("keeps an opened element's top in view when it is taller than the list", () => {
    const to = revealTarget({ top: 400, height: 2000 }, list, "reveal")!;
    expect(400 - (to - 1000)).toBe(TOP_GAP);
  });
});
