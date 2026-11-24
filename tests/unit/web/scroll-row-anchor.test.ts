/**
 * Element-relative anchoring: the row being read is measured before rows go in above it and put
 * back at the same offset afterwards. happy-dom has no layout, so rows are laid out by hand: each
 * row's top is its position in the content minus the scroll offset.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
const { firstVisibleRow, restoreRow, turnStartAt, attrSelector, readingAnchorAt, restoreReadingAnchor, userAnchorKey } = await import("../../../src/web/components/chat/scroll-row-anchor");
afterAll(() => uninstallDom());

/** A container at y=100 holding rows of the given heights; `turn` marks a turn's first row, `user` a user message's text. */
function scene(rows: Array<{ id: string; h: number; turn?: string; user?: string }>) {
  const el = document.createElement("div");
  const g = { scrollTop: 0, rows: [...rows] };
  Object.defineProperty(el, "scrollTop", { get: () => g.scrollTop, set: (v: number) => { g.scrollTop = v; } });
  el.getBoundingClientRect = () => ({ top: 100, bottom: 700 } as DOMRect);
  const draw = () => {
    el.innerHTML = "";
    let y = 0;
    for (const r of g.rows) {
      const row = document.createElement("div");
      row.dataset.msgId = r.id;
      if (r.turn) row.dataset.turnStart = r.turn;
      if (r.user) row.dataset.anchorKey = userAnchorKey(r.user);
      const top = y;
      row.getBoundingClientRect = () => ({ top: 100 + top - g.scrollTop, bottom: 100 + top + r.h - g.scrollTop } as DOMRect);
      el.appendChild(row);
      y += r.h;
    }
  };
  draw();
  return { el, g, draw, top: (id: string) => el.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)!.getBoundingClientRect().top - 100 };
}

describe("scroll-row-anchor", () => {
  it("keeps the row being read in place when a page goes in above it", () => {
    const s = scene([{ id: "a", h: 300 }, { id: "b", h: 300 }, { id: "c", h: 300 }]);
    s.g.scrollTop = 350; // reading inside "b", 50 px of it above the top
    const anchor = firstVisibleRow(s.el)!;
    expect(anchor).toEqual({ key: "b", offset: -50 });
    s.g.rows.unshift({ id: "x", h: 420 }, { id: "y", h: 180 });
    s.draw();
    expect(restoreRow(s.el, anchor)).toBe(true);
    expect(Math.abs(s.top("b") - -50)).toBeLessThanOrEqual(2);
  });

  it("finds the first visible row in a long list", () => {
    const s = scene(Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, h: 50 })));
    s.g.scrollTop = 12_345;
    expect(firstVisibleRow(s.el)).toEqual({ key: "r246", offset: -45 });
  });

  it("keeps the place when the answer being read is finalised under another id and a card goes in above", () => {
    const s = scene([{ id: "old", h: 400 }, { id: "user-1", h: 80, user: "hi" }, { id: "streaming-1", h: 900 }]);
    s.g.scrollTop = 700; // reading inside the answer
    const anchor = readingAnchorAt(s.el)!;
    const before = s.top("streaming-1");
    s.g.rows = [{ id: "old", h: 400 }, { id: "card", h: 300 }, { id: "user-1", h: 80, user: "hi" }, { id: "final-1", h: 900 }];
    s.draw();
    expect(restoreReadingAnchor(s.el, anchor)).toBe(true);
    expect(Math.abs(s.top("final-1") - before)).toBeLessThanOrEqual(2);
  });

  it("keeps the place when history replaces every row the browser made, by the reader's own message", () => {
    const s = scene([{ id: "old", h: 400 }, { id: "user-1", h: 80, user: "what changed?" }, { id: "streaming-1", h: 900 }]);
    s.g.scrollTop = 700;
    const anchor = readingAnchorAt(s.el)!;
    const before = s.top("streaming-1");
    // History: the same message under the server's id, the answer split per block, a card above it.
    s.g.rows = [{ id: "old", h: 400 }, { id: "card", h: 300 }, { id: "9f0c", h: 80, user: "what changed?" }, { id: "b1", h: 400 }, { id: "b2", h: 500 }];
    s.draw();
    expect(restoreReadingAnchor(s.el, anchor)).toBe(true);
    // Restored by the reader's message, not by "old" further up, which the card moved away from it.
    expect(Math.abs(s.top("b1") - before)).toBeLessThanOrEqual(2);
  });

  it("says when the anchored row is gone", () => {
    const s = scene([{ id: "a", h: 300 }]);
    expect(restoreRow(s.el, { key: "zz", offset: 0 })).toBe(false);
  });

  it("names the turn the reader is in at the top", () => {
    const s = scene([{ id: "u1", h: 200, turn: "T1" }, { id: "a1", h: 400 }, { id: "u2", h: 200, turn: "T2" }, { id: "a2", h: 900 }]);
    s.g.scrollTop = 300; // inside turn 1's answer
    expect(turnStartAt(s.el)!.key).toBe("T1");
    s.g.scrollTop = 650; // turn 2 has reached the top
    expect(turnStartAt(s.el)!.key).toBe("T2");
    s.g.scrollTop = 0;
    expect(turnStartAt(s.el)!.key).toBe("T1");
  });

  it("quotes what an attribute value needs", () => {
    expect(attrSelector("data-msg-id", `a"b\\c`)).toBe(`[data-msg-id="a\\"b\\\\c"]`);
  });
});
