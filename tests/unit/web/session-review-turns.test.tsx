/**
 * The Review tab's turn chips: each block names the turns that wrote it, and a turn opens to the
 * prompt behind it with a way into the chat. Mounted, because the wiring is where it can quietly
 * do nothing — a chip whose card never opens, a "Show in chat" that names the wrong call, an
 * Escape the tab's own keys also act on.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, installGlobal, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { ReviewCode } = await import("../../../src/web/components/session-review/review-code.tsx");
const { paneModel } = await import("../../../src/web/lib/session-review-model.ts");
const { sessionTurns, turnsByCall } = await import("../../../src/web/lib/session-turns.ts");
const { useSessionTurns } = await import("../../../src/web/hooks/use-session-turns.ts");
const { useSessionTurnsStore } = await import("../../../src/web/stores/session-turns-store.ts");
type SessionTurn = import("../../../src/web/lib/session-turns.ts").SessionTurn;
type ChatMessage = import("../../../src/types/chat.ts").ChatMessage;
type SessionFileChange = import("../../../src/shared/session-file-changes.ts").SessionFileChange;

const file: SessionFileChange = { path: "/p/src/a.ts", status: "modified", baseline: "session", additions: 2, deletions: 1, version: "1:1" };
const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join("");
const modified = original.replace("line 3\n", "line three\n").replace("line 25\n", "line 25\nadded\n");

const msg = (id: string, role: "user" | "assistant", minute: number, content: string, calls: string[] = []): ChatMessage => ({
  id,
  role,
  content,
  timestamp: new Date(2026, 9, 3, 14, minute).toISOString(),
  events: calls.map((toolUseId) => ({ type: "tool_use" as const, tool: "Edit", input: {}, toolUseId })),
});
const turns = turnsByCall(sessionTurns([
  msg("u1", "user", 1, "rename line three"),
  msg("a1", "assistant", 2, "", ["toolu_1", "toolu_1b"]),
  msg("u2", "user", 5, "and add a line near the end"),
  msg("a2", "assistant", 6, "", ["toolu_2"]),
]));

function model() {
  const plain = paneModel({ original, modified, version: "1:1", kept: new Set(), reverted: [] })!;
  const [first, second] = plain.items.filter((i) => i.kind === "block").map((i) => i.key);
  // The first block was written by both turns, the newer call listed first, and by two calls of the first.
  return paneModel({
    original,
    modified,
    version: "1:1",
    kept: new Set(),
    reverted: [],
    calls: new Map([[first!, ["toolu_2", "toolu_1", "toolu_1b"]], [second!, ["toolu_2"]]]),
  })!;
}

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

async function render(compact = false) {
  const shown: [SessionTurn, string][] = [];
  const noop = () => {};
  view = await mount(
    <ReviewCode
      file={file}
      model={model()}
      focusKey={null}
      compact={compact}
      lang={undefined}
      turns={turns}
      actions={{ focus: noop, keep: noop, revert: noop, reopen: noop, undo: noop, showInChat: (turn, call) => shown.push([turn, call]) }}
    />,
  );
  const blocks = [...view.container.querySelectorAll("[data-block-key]")];
  return { shown, blocks };
}

const chipsOf = (block: Element) => [...block.querySelectorAll("[data-turn-chip]")];
const buttonByText = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) ?? null;

describe("turn chips in the Review tab", () => {
  it("name every turn that wrote a block once, oldest first, with the prompt as their title", async () => {
    const { blocks } = await render();
    expect(blocks).toHaveLength(2);
    expect(chipsOf(blocks[0]!).map((c) => c.textContent?.replace(/·.*/, "").trim())).toEqual(["Turn 1", "Turn 2"]);
    expect(chipsOf(blocks[0]!)[0]!.getAttribute("title")).toBe("rename line three");
    expect(chipsOf(blocks[1]!).map((c) => c.textContent?.replace(/·.*/, "").trim())).toEqual(["Turn 2"]);
  });

  it("open to the prompt, and show the chat at the call that wrote the block", async () => {
    const { shown, blocks } = await render();
    const chip = chipsOf(blocks[0]!)[1]!;
    await click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    const card = blocks[0]!.querySelector("[data-turn-pop]");
    expect(card?.querySelector("blockquote")?.textContent).toBe("and add a line near the end");
    await click(buttonByText(card!, "Show in chat"));
    expect(shown.map(([turn, call]) => [turn.messageId, call])).toEqual([["u2", "toolu_2"]]);
    expect(blocks[0]!.querySelector("[data-turn-pop]")).toBeNull();
  });

  it("close on a second click, on Escape before the tab's keys see it, and on a press outside", async () => {
    const { blocks } = await render();
    const chip = chipsOf(blocks[0]!)[0]!;
    await click(chip);
    await click(chip);
    expect(blocks[0]!.querySelector("[data-turn-pop]")).toBeNull();

    await click(chip);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { chip.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    expect(blocks[0]!.querySelector("[data-turn-pop]")).toBeNull();

    await click(chip);
    await act(async () => { blocks[1]!.querySelector(".grid")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(blocks[0]!.querySelector("[data-turn-pop]")).toBeNull();

    // Nothing open: Escape is left to the tab.
    const free = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { chip.dispatchEvent(free); });
    expect(free.defaultPrevented).toBe(false);
  });

  it("open in a sheet on a phone, with full-size buttons", async () => {
    const { shown, blocks } = await render(true);
    await click(chipsOf(blocks[1]!)[0]!);
    expect(blocks[1]!.querySelector("[data-turn-pop]")).toBeNull();
    const card = document.body.querySelector("[data-turn-pop]");
    expect(card?.querySelector("blockquote")?.textContent).toBe("and add a line near the end");
    const show = buttonByText(card!, "Show in chat")!;
    expect(show.getAttribute("class")).toContain("h-11");
    expect(buttonByText(card!, "Copy prompt")!.getAttribute("class")).toContain("h-11");
    await click(show);
    expect(shown.map(([turn, call]) => [turn.messageId, call])).toEqual([["u2", "toolu_2"]]);
  });

  it("leave a block whose calls belong to no turn the chat knows without a chip", async () => {
    const plain = paneModel({ original, modified, version: "1:1", kept: new Set(), reverted: [] })!;
    const noop = () => {};
    view = await mount(
      <ReviewCode
        file={file}
        model={plain}
        focusKey={null}
        compact={false}
        lang={undefined}
        turns={new Map()}
        actions={{ focus: noop, keep: noop, revert: noop, reopen: noop, undo: noop, showInChat: noop }}
      />,
    );
    expect(view.container.querySelectorAll("[data-turn-chip]")).toHaveLength(0);
  });
});

describe("the turns the Review tab knows", () => {
  const history = [
    msg("u1", "user", 1, "rename line three"),
    msg("a1", "assistant", 2, "", ["toolu_1"]),
  ];

  function stubMessages() {
    const asked: string[] = [];
    installGlobal("fetch", async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ ok: true, data: { messages: history } }));
    });
    return asked;
  }

  function Probe(p: { sessionId: string; calls: string[] }) {
    const byCall = useSessionTurns({ projectName: "proj", sessionId: p.sessionId, providerId: "claude", calls: p.calls });
    return <span data-placed={[...byCall.keys()].join(",")} />;
  }
  const placed = () => view!.container.querySelector("span")!.getAttribute("data-placed");
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  it("are fetched with no chat open, once for calls no fetch could place", async () => {
    const asked = stubMessages();
    view = await mount(<Probe sessionId="s-fetch" calls={["toolu_1", "toolu_gone"]} />);
    await settle();
    expect(asked).toEqual(["/api/project/proj/chat/sessions/s-fetch/messages?providerId=claude"]);
    expect(placed()).toBe("toolu_1");
    await view.unmount();
    view = await mount(<Probe sessionId="s-fetch" calls={["toolu_1", "toolu_gone"]} />);
    await settle();
    expect(asked).toHaveLength(1);
  });

  it("come from the open chat, which nothing fetched replaces", async () => {
    const asked = stubMessages();
    useSessionTurnsStore.getState().publish("s-live", sessionTurns([...history, msg("u2", "user", 3, "more"), msg("a2", "assistant", 4, "", ["toolu_2"])]), true);
    view = await mount(<Probe sessionId="s-live" calls={["toolu_2", "toolu_unknown"]} />);
    await settle();
    expect(asked).toEqual([]);
    expect(placed()).toBe("toolu_1,toolu_2");
  });

  it("are not replaced by the same turns again, and outlive the chat that published them", () => {
    const store = useSessionTurnsStore.getState();
    store.publish("s-same", sessionTurns(history), true);
    const first = useSessionTurnsStore.getState().bySession["s-same"];
    store.publish("s-same", sessionTurns([...history]), true);
    expect(useSessionTurnsStore.getState().bySession["s-same"]).toBe(first);
    store.release("s-same");
    expect(useSessionTurnsStore.getState().bySession["s-same"]).toMatchObject({ live: false, turns: first!.turns });
  });
});
