/**
 * Element-relative anchoring: the row being read is measured before rows go in above it and put
 * back at the same offset afterwards. happy-dom has no layout, so rows are laid out by hand: each
 * row's top is its position in the content minus the scroll offset.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
const { firstVisibleRow, restoreRow, turnStartAt, attrSelector } = await import("../../../src/web/components/chat/scroll-row-anchor");
afterAll(() => uninstallDom());

/** A container at y=100 holding rows of the given heights; `turn` marks a turn's first row. */
function scene(rows: Array<{ id: string; h: number; turn?: string }>) {
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
