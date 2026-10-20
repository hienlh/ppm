/**
 * The changes bar and the turn pills kept current while the agent works. The list is asked for on
 * opening the chat and when a turn ends — cheap now that the server keeps it and works out only
 * what moved — and in between the server pushes the rows of the files the agent just changed.
 * The real hook, bar and pill, wired the way chat-tab.tsx wires them, with the pushes delivered
 * through the real useGlobalEvents, against a fake server.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, installGlobal, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act, useState } = await import("react");
const { useSessionFileChanges } = await import("../../../src/web/hooks/use-session-file-changes.ts");
const { useGlobalEvents } = await import("../../../src/web/hooks/use-global-events.ts");
const { WsClient } = await import("../../../src/web/lib/ws-client.ts");
const { SessionChangesBar } = await import("../../../src/web/components/chat/session-changes-bar.tsx");
const { TurnChangeRollup } = await import("../../../src/web/components/chat/turn-change-rollup.tsx");
const { SessionChangesContext } = await import("../../../src/web/components/chat/session-changes-context.tsx");
const { useProjectStore } = await import("../../../src/web/stores/project-store.ts");
const { useSessionTurnsStore } = await import("../../../src/web/stores/session-turns-store.ts");
const { sessionTurns } = await import("../../../src/web/lib/session-turns.ts");
const { announceReviewMarks } = await import("../../../src/web/lib/session-file-changes-client.ts");
type TurnFileChange = import("../../../src/web/lib/aggregate-turn-file-changes.ts").TurnFileChange;
type SessionFileChange = import("../../../src/shared/session-file-changes.ts").SessionFileChange;
type ChatMessage = import("../../../src/types/chat.ts").ChatMessage;

const A = "/work/proj/src/a.ts";
const B = "/work/proj/src/b.ts";

const message = (id: string, role: "user" | "assistant", calls: { id: string; path: string }[] = []): ChatMessage => ({
  id, role, content: role === "user" ? `ask ${id}` : "", timestamp: "2026-10-17T10:00:00.000Z",
  events: calls.map((c) => ({
    type: "tool_use" as const, tool: "Edit", toolUseId: c.id,
    input: { file_path: c.path, old_string: "x", new_string: "y" }, result: "ok",
  })) as never,
});
const turnChange = (path: string, call: string): TurnFileChange => ({
  filePath: path, op: "edit", editCount: 1, linesAdded: 1, linesRemoved: 1, viaSubagent: false,
  edits: [{ oldStr: "x", newStr: "y", toolUseId: call, editIndex: 0, editRef: `${call}-0`, viaSubagent: false }],
});
/** A row as the server lists it: one block per call list. */
const row = (path: string, calls: string[][]): SessionFileChange => ({
  path, status: "modified", baseline: "session", additions: calls.length, deletions: calls.length, version: `v${calls.length}`,
  blocks: calls.map((c, i) => ({ key: `${path}#${i}`, added: 1, removed: 1, calls: c })),
});

/** What the fake server answers right now, how often the list was asked for, and a gate to hold it. */
let server: { count: number; list: SessionFileChange[] };
let listAsks = 0;
let hold: Promise<void> | null = null;
let deliver: ((e: { data: string }) => void) | null = null;
const spies: { mockRestore: () => void }[] = [];

beforeEach(() => {
  server = { count: 0, list: [] };
  listAsks = 0;
  hold = null;
  useProjectStore.setState({ projects: [{ name: "proj", path: "/work/proj" }] as never });
  installGlobal("fetch", async (url: string) => {
    const u = String(url);
    let data: unknown = {};
    if (u.endsWith("/file-changes/count")) data = { count: server.count };
    else if (u.endsWith("/file-changes")) {
      listAsks++;
      const answer = server.list;
      if (hold) await hold;
      data = { files: answer };
    }
    return new Response(JSON.stringify({ ok: true, data }));
  });
  spies.push(
    spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "disconnect").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "send").mockImplementation(() => {}),
    spyOn(WsClient.prototype, "onMessage").mockImplementation(((handler: (e: { data: string }) => void) => {
      deliver = handler;
      return () => {};
    }) as never),
  );
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

let setChat: (c: { messages: ChatMessage[]; isStreaming: boolean }) => void = () => {};

function Chat({ initial, pill }: { initial: ChatMessage[]; pill?: { changes: TurnFileChange[]; turnIndex: number } }) {
  useGlobalEvents(true, "proj");
  const [chat, set] = useState({ messages: initial, isStreaming: false });
  setChat = set;
  const s = useSessionFileChanges({ projectName: "proj", sessionId: "s1", messages: chat.messages, isStreaming: chat.isStreaming });
  const turns = sessionTurns(chat.messages);
  useSessionTurnsStore.getState().publish("s1", turns, true);
  return (
    <SessionChangesContext.Provider value={{ projectName: "proj", sessionId: "s1", files: s.files, refresh: s.refresh, openReview: () => {} }}>
      <SessionChangesBar
        files={s.files} loaded={s.loaded} loading={s.loading} unloadedCount={s.unloadedCount}
        projectName="proj" onOpen={s.refresh} onRefresh={s.refresh} onSetReviewed={s.setReviewed} onReview={() => {}}
      />
      {pill && turns[pill.turnIndex] && !chat.isStreaming && (
        <TurnChangeRollup timestamp="2026-10-17T10:01:00.000Z" content="done" changes={pill.changes} turn={turns[pill.turnIndex]} />
      )}
    </SessionChangesContext.Provider>
  );
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const barText = (root: ParentNode) => root.querySelector('[data-testid="session-changes-bar"]')?.textContent ?? null;
const pillStatus = (root: ParentNode) => [...root.querySelectorAll("[data-testid=turn-review-status]")].map((e) => e.textContent);
const push = (files: SessionFileChange[], gone: string[] = []) =>
  act(async () => { deliver!({ data: JSON.stringify({ type: "session:file-changes", projectName: "proj", sessionId: "s1", files, gone }) }); });

const turn1 = [message("u1", "user"), message("a1", "assistant", [{ id: "toolu_1", path: A }])];

/** The agent's second turn: streaming starts with the edit named, the file changes on disk, the turn ends. */
async function secondTurn(call: { id: string; path: string }, after: typeof server) {
  const messages = [...turn1, message("u2", "user"), message("a2", "assistant", [call])];
  await act(async () => setChat({ messages: messages.slice(0, 3), isStreaming: true }));
  await act(async () => setChat({ messages, isStreaming: true }));
  await settle();
  server = after;
  await act(async () => setChat({ messages, isStreaming: false }));
  await settle();
}

describe("the session's changes, kept current", () => {
  it("are asked for on opening the chat and when a turn ends, never because the transcript moved", async () => {
    server = { count: 1, list: [row(A, [["toolu_1"]])] };
    view = await mount(<Chat initial={turn1} />);
    await settle();
    expect(listAsks).toBe(1);
    expect(barText(view.container)).toContain("1 file changed");

    const messages = [...turn1, message("u2", "user"), message("a2", "assistant", [{ id: "toolu_2", path: B }])];
    await act(async () => setChat({ messages: messages.slice(0, 3), isStreaming: true }));
    await act(async () => setChat({ messages, isStreaming: true }));
    await settle();
    expect(listAsks).toBe(1);

    server = { count: 2, list: [row(A, [["toolu_1"]]), row(B, [["toolu_2"]])] };
    await act(async () => setChat({ messages, isStreaming: false }));
    await settle();
    expect(listAsks).toBe(2);
    expect(barText(view.container)).toContain("2 files changed");
  });

  it("put the rows the server pushes in place, without asking", async () => {
    server = { count: 1, list: [row(A, [["toolu_1"]])] };
    view = await mount(<Chat initial={turn1} />);
    await settle();

    await push([row(A, [["toolu_1"], ["toolu_2"]]), row(B, [["toolu_3"]])]);
    expect(barText(view.container)).toContain("2 files changed");
    expect(barText(view.container)).toContain("+3");

    await push([], [B]);
    expect(barText(view.container)).toContain("1 file changed");
    expect(listAsks).toBe(1);
  });

  it("ask again once a list is in when a row was pushed while it was on its way", async () => {
    server = { count: 1, list: [row(A, [["toolu_1"]])] };
    let release = () => {};
    hold = new Promise((r) => { release = r; });
    view = await mount(<Chat initial={turn1} />);
    await settle();
    expect(listAsks).toBe(1);

    // The list being answered may already be older than this row: it is set aside.
    await push([row(B, [["toolu_2"]])]);
    hold = null;
    server = { count: 2, list: [row(A, [["toolu_1"]]), row(B, [["toolu_2"]])] };
    await act(async () => release());
    await settle();
    expect(listAsks).toBe(2);
    expect(barText(view.container)).toContain("2 files changed");
  });

  it("never call the agent's new edit 'reverted' on a later turn's pill", async () => {
    server = { count: 1, list: [row(A, [["toolu_1"]])] };
    view = await mount(<Chat initial={turn1} pill={{ changes: [turnChange(A, "toolu_2")], turnIndex: 1 }} />);
    await settle();
    await click(view.container.querySelector('[data-testid="session-changes-bar"] button')!);
    await settle();

    // Turn 2 edits a.ts again: the server names toolu_2 as the writer of a new block.
    await secondTurn({ id: "toolu_2", path: A }, { count: 1, list: [row(A, [["toolu_1"], ["toolu_2"]])] });
    expect(pillStatus(view.container)).toEqual(["1 edit to review"]);
  });

  it("bring the bar back when a later turn changes files after a refresh found none", async () => {
    server = { count: 1, list: [row(A, [["toolu_1"]])] };
    view = await mount(<Chat initial={turn1} />);
    await settle();
    // Everything put back from the Review tab: the refresh after it finds nothing.
    server = { count: 1, list: [] };
    await act(async () => announceReviewMarks({ projectName: "proj", sessionId: "s1" }));
    await settle();
    expect(barText(view.container)).toBeNull();

    await secondTurn({ id: "toolu_2", path: B }, { count: 2, list: [row(B, [["toolu_2"]])] });
    expect(barText(view.container)).toContain("1 file changed");
  });
});
