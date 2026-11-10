/**
 * A host's items among a chat's rows: without them the rows draw exactly as before; with them an
 * item lands right before the row it precedes in time, and a hidden row draws nothing while the
 * rows around it keep their indexes. Also the card menu's items per card state.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { MessageRows } = await import("../../../src/web/components/chat/message-rows");
const { cardMenuItems } = await import("../../../src/web/components/assistant/cards/card-menu");
type Msg = import("../../../src/types/chat").ChatMessage;
type Card = import("../../../src/shared/assistant-cards").AssistantCard;

const rows: Msg[] = [
  { id: "u1", role: "user", content: "How is nxsys?", timestamp: "2026-11-10T09:00:00.000Z" },
  { id: "a1", role: "assistant", content: "", timestamp: "2026-11-10T09:00:05.000Z", events: [{ type: "text", content: "Asking its manager." }] },
  { id: "u2", role: "user", content: "And ppm?", timestamp: "2026-11-10T09:10:00.000Z" },
];
const base = { rows, userOrdinals: [1, 0, 2], userOrdinalOffset: 0, isStreaming: false, historyPredecessorId: null };

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

/** The rows once the lazily loaded markdown block has replaced its skeleton. */
async function settledHtml(mounted: Mounted): Promise<string> {
  const { act } = await import("react");
  for (let i = 0; i < 100 && mounted.container.querySelector(".animate-pulse"); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  expect(mounted.container.querySelector(".animate-pulse")).toBeNull();
  return mounted.container.innerHTML;
}

describe("chat timeline extension", () => {
  it("draws a plain chat identically with an empty extension", async () => {
    view = await mount(createElement(MessageRows, base));
    const plain = await settledHtml(view);
    await view.unmount();
    view = await mount(createElement(MessageRows, { ...base, hidden: new Set<string>(), before: new Map() }));
    expect(await settledHtml(view)).toBe(plain);
  });

  it("puts an item before its row and draws nothing for a hidden row", async () => {
    view = await mount(createElement(MessageRows, {
      ...base,
      hidden: new Set(["a1"]),
      before: new Map([[2, [createElement("p", { key: "c", "data-item": "card" }, "Card")]]]),
    }));
    const order = [...view.container.querySelectorAll("[data-msg-id], [data-item]")]
      .map((el) => el.getAttribute("data-msg-id") ?? `item:${el.getAttribute("data-item")}`);
    expect(order).toEqual(["u1", "item:card", "u2"]);
    expect(view.container.querySelector('[data-msg-id="u2"]')?.getAttribute("data-msg-index")).toBe("2");
  });
});

describe("card menu", () => {
  const card = (over: Partial<Card>): Card => ({
    id: "c", kind: "needs_decision", projectName: "nxsys", projectKey: "k", sessionId: "mgr-1", title: "T", body: "",
    payload: {}, status: "open", answer: null, provenance: null, createdAt: 1, updatedAt: 1, ...over,
  });
  const labels = (c: Card) => cardMenuItems(c).map((i) => i.label);

  it("offers Reply, Open manager chat and Dismiss on a waiting decision", () => {
    expect(labels(card({}))).toEqual(["Reply", "Open manager chat", "Dismiss"]);
  });
  it("drops Dismiss once a card stopped waiting, and everything manager-bound without a manager", () => {
    expect(labels(card({ status: "answered" }))).toEqual(["Reply", "Open manager chat"]);
    expect(labels(card({ kind: "digest", projectName: null, sessionId: null, status: "info" }))).toEqual([]);
    expect(labels(card({ kind: "budget", projectName: null, sessionId: null }))).toEqual(["Dismiss"]);
  });
});
