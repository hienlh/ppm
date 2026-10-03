/**
 * The chat's change tray answering the session review: the pill says what is left, each edit
 * keeps or reverts the blocks its call wrote, and the whole turn is kept or reverted — the revert
 * asked first, with what a later turn changed again named and left alone. Mounted against a fake
 * server, because a button that posts the wrong keys or the wrong version looks exactly like one
 * that works.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, installGlobal, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act, useState } = await import("react");
const { TurnChangeRollup } = await import("../../../src/web/components/chat/turn-change-rollup.tsx");
const { SessionChangesContext } = await import("../../../src/web/components/chat/session-changes-context.tsx");
const { useSessionTurnsStore } = await import("../../../src/web/stores/session-turns-store.ts");
const { sessionTurns } = await import("../../../src/web/lib/session-turns.ts");
type TurnFileChange = import("../../../src/web/lib/aggregate-turn-file-changes.ts").TurnFileChange;
type SessionFileChange = import("../../../src/shared/session-file-changes.ts").SessionFileChange;
type ChatMessage = import("../../../src/types/chat.ts").ChatMessage;

const changes: TurnFileChange[] = [
  {
    filePath: "/work/proj/src/a.ts",
    op: "edit",
    editCount: 2,
    linesAdded: 2,
    linesRemoved: 1,
    viaSubagent: false,
    edits: [
      { oldStr: "one", newStr: "uno", toolUseId: "toolu_1", editIndex: 0, editRef: "toolu_1-0", viaSubagent: false },
      { oldStr: "", newStr: "two", toolUseId: "toolu_2", editIndex: 0, editRef: "toolu_2-0", viaSubagent: false },
    ],
  },
  {
    filePath: "/work/proj/src/b.ts",
    op: "edit",
    editCount: 1,
    linesAdded: 1,
    linesRemoved: 0,
    viaSubagent: false,
    edits: [{ oldStr: "", newStr: "three", toolUseId: "toolu_3", editIndex: 0, editRef: "toolu_3-0", viaSubagent: false }],
  },
];
const files: SessionFileChange[] = [
  {
    path: "/work/proj/src/a.ts", status: "modified", baseline: "session", additions: 2, deletions: 1, version: "va",
    blocks: [
      { key: "ka1", added: 1, removed: 1, calls: ["toolu_1"] },
      { key: "ka2", added: 1, removed: 0, calls: ["toolu_2"] },
      { key: "ka3", added: 1, removed: 0, kept: true, calls: ["toolu_1"] },
    ],
  },
  {
    path: "/work/proj/src/b.ts", status: "modified", baseline: "session", additions: 1, deletions: 0, version: "vb",
    blocks: [{ key: "kb1", added: 1, removed: 0, kept: true, calls: ["toolu_3"] }],
  },
];
const msg = (id: string, role: "user" | "assistant", content: string, calls: string[] = []): ChatMessage => ({
  id, role, content, timestamp: "2026-10-03T14:00:00.000Z",
  events: calls.map((toolUseId) => ({ type: "tool_use" as const, tool: "Edit", input: {}, toolUseId })),
});
const turns = sessionTurns([
  msg("u1", "user", "rename one"),
  msg("a1", "assistant", "", ["toolu_1", "toolu_2", "toolu_3", "toolu_bash"]),
  msg("u2", "user", "and more"),
  msg("a2", "assistant", "", ["toolu_9"]),
]);

/** Every POST the tray made, and what the fake server answers to each route. */
let posted: { url: string; body: Record<string, unknown> }[] = [];
let answers: Record<string, unknown> = {};
let refreshed = 0;
const realWidth = window.innerWidth;

beforeEach(() => {
  posted = [];
  refreshed = 0;
  answers = {
    answer: { files: [] },
    undo: { files: [] },
    "revert-turn": { files: [] },
  };
  installGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    posted.push({ url: String(url), body });
    const route = String(url).split("/file-changes/")[1] ?? "";
    const data = typeof answers[route] === "function" ? (answers[route] as (b: unknown) => unknown)(body) : answers[route];
    return new Response(JSON.stringify({ ok: true, data }));
  });
  useSessionTurnsStore.getState().publish("s1", turns, true);
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
});

/** Hands the list the chat would read next, the way a refresh after an answer does. */
let setList: (list: SessionFileChange[]) => void = () => {};

function Chat({ initial }: { initial: SessionFileChange[] }) {
  const [list, set] = useState(initial);
  setList = set;
  return (
    <SessionChangesContext.Provider value={{ projectName: "proj", sessionId: "s1", files: list, refresh: () => refreshed++, openReview: () => {} }}>
      <TurnChangeRollup timestamp="2026-10-03T14:01:00.000Z" content="done" changes={changes} turn={turns[0]} />
    </SessionChangesContext.Provider>
  );
}

async function render(list: SessionFileChange[] = files) {
  view = await mount(<Chat initial={list} />);
  return view.container;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const byText = (root: ParentNode, text: string, tag = "button") =>
  [...root.querySelectorAll<HTMLElement>(tag)].find((b) => b.textContent?.includes(text)) ?? null;
const pill = (root: ParentNode) => root.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const editCard = (root: ParentNode, call: string) => root.querySelector(`[data-edit-key*="${call}"]`)!;
const route = (p: { url: string }) => p.url.replace(/^.*\/file-changes\/?/, "");

describe("the change pill", () => {
  it("says how many of the turn's edits are left to review", async () => {
    const root = await render();
    expect(root.querySelector("[data-testid=turn-review-status]")?.textContent).toBe("2 edits to review");
  });

  it("says nothing about review where the list cannot say which call wrote what", async () => {
    const root = await render(files.map((f) => ({ ...f, blocks: f.blocks!.map(({ calls: _, ...b }) => b) })));
    expect(root.querySelector("[data-testid=turn-review-status]")).toBeNull();
    await click(pill(root));
    expect(byText(root, "Keep all")).toBeNull();
    expect(byText(root, "Revert turn")).toBeNull();
    expect(editCard(root, "toolu_1").getAttribute("data-state")).toBe("unknown");
  });
});

describe("the change tray", () => {
  it("keeps an edit's open blocks at the version the list drew, then asks for the list again", async () => {
    const root = await render();
    await click(pill(root));
    expect(editCard(root, "toolu_3").getAttribute("data-state")).toBe("kept");
    await click(byText(editCard(root, "toolu_1"), "Keep"));
    await settle();
    expect(posted.map((p) => [route(p), p.body])).toEqual([
      ["answer", { answer: "keep", files: [{ path: "/work/proj/src/a.ts", version: "va", keys: ["ka1"] }] }],
    ]);
    expect(refreshed).toBe(1);
  });

  it("reverts an edit's blocks, says so, and undoes it", async () => {
    answers.answer = { files: [], undoId: "undo-7" };
    const root = await render();
    await click(pill(root));
    await click(byText(editCard(root, "toolu_2"), "Revert"));
    await settle();
    expect(posted[0]!.body).toEqual({ answer: "revert", files: [{ path: "/work/proj/src/a.ts", version: "va", keys: ["ka2"] }] });
    const notice = root.querySelector("[data-testid=turn-review-notice]")!;
    expect(notice.textContent).toContain("Reverted 1 block.");
    await click(byText(notice, "Undo"));
    await settle();
    expect(posted.map(route)).toEqual(["answer", "undo"]);
    expect(posted[1]!.body).toEqual({ undoId: "undo-7" });
  });

  it("keeps every open block of the turn at once", async () => {
    const root = await render();
    await click(pill(root));
    await click(byText(root, "Keep all"));
    await settle();
    expect(posted[0]!.body).toEqual({ answer: "keep", files: [{ path: "/work/proj/src/a.ts", version: "va", keys: ["ka1", "ka2"] }] });
  });

  it("asks before reverting the turn, names what a later turn changed again, then reverts as shown", async () => {
    answers["revert-turn"] = (body: { apply?: unknown }) => body.apply
      ? { files: [], undoId: "undo-turn" }
      : {
          files: [
            { path: "/work/proj/src/a.ts", version: "va", action: "edit", changes: 2, added: 2, removed: 1, skipped: [{ line: 4, by: ["toolu_9"] }] },
            { path: "/work/proj/src/b.ts", version: "vb", action: "delete", changes: 1, added: 1, removed: 0, skipped: [] },
          ],
        };
    const root = await render();
    await click(pill(root));
    await click(byText(root, "Revert turn…"));
    await settle();
    expect(posted.map((p) => [route(p), p.body])).toEqual([["revert-turn", { calls: ["toolu_1", "toolu_2", "toolu_3", "toolu_bash"] }]]);
    const confirm = root.querySelector("[data-testid=revert-turn-confirm]")!;
    expect(confirm.getAttribute("aria-label")).toBe("Revert Turn 1?");
    expect(confirm.textContent).toContain("b.ts");
    expect(confirm.textContent).toContain("file removed");
    expect(confirm.textContent).toContain("a.ts line 4 stays as it is — Turn 2 changed it again.");
    // Nothing is written until it is confirmed.
    expect(posted).toHaveLength(1);

    await click(byText(confirm, "Revert turn"));
    await settle();
    expect(posted[1]!.body).toEqual({
      calls: ["toolu_1", "toolu_2", "toolu_3", "toolu_bash"],
      apply: [{ path: "/work/proj/src/a.ts", version: "va" }, { path: "/work/proj/src/b.ts", version: "vb" }],
    });
    expect(root.querySelector("[data-testid=revert-turn-confirm]")).toBeNull();
    expect(root.querySelector("[data-testid=turn-review-notice]")!.textContent).toContain("Reverted this turn's changes.");
  });

  it("counts only the files it puts something back in, and offers nothing when every line changed again", async () => {
    const skippedOnly = { path: "/work/proj/src/b.ts", version: "vb", action: "none", changes: 0, added: 0, removed: 0, skipped: [{ line: 2, by: ["toolu_9"] }] };
    answers["revert-turn"] = { files: [{ path: "/work/proj/src/a.ts", version: "va", action: "edit", changes: 1, added: 1, removed: 0, skipped: [] }, skippedOnly] };
    const root = await render();
    await click(pill(root));
    await click(byText(root, "Revert turn…"));
    await settle();
    const confirm = root.querySelector("[data-testid=revert-turn-confirm]")!;
    expect(confirm.textContent).toContain("1 change in 1 file");
    expect(confirm.textContent).toContain("b.ts line 2 stays as it is");
    expect(byText(confirm, "Revert turn")!.hasAttribute("disabled")).toBe(false);

    await click(byText(confirm, "Cancel"));
    answers["revert-turn"] = { files: [skippedOnly] };
    await click(byText(root, "Revert turn…"));
    await settle();
    expect(byText(root.querySelector("[data-testid=revert-turn-confirm]")!, "Revert turn")!.hasAttribute("disabled")).toBe(true);
  });

  it("shows what the turn's revert took away as reverted, and no longer once it is undone", async () => {
    answers["revert-turn"] = (body: { apply?: unknown }) => body.apply
      ? { files: [{ path: "/work/proj/src/b.ts", version: "vb", action: "delete", changes: 1, added: 1, removed: 0, skipped: [] }], undoId: "undo-turn" }
      : { files: [{ path: "/work/proj/src/b.ts", version: "vb", action: "delete", changes: 1, added: 1, removed: 0, skipped: [] }] };
    const root = await render();
    await click(pill(root));
    await click(byText(root, "Revert turn…"));
    await settle();
    await click(byText(root.querySelector("[data-testid=revert-turn-confirm]")!, "Revert turn"));
    await settle();
    // The file the turn created is gone, so the list no longer has it to say anything about.
    await act(async () => setList(files.filter((f) => !f.path.endsWith("b.ts"))));
    expect(editCard(root, "toolu_3").getAttribute("data-state")).toBe("reverted");

    await click(byText(editCard(root, "toolu_3"), "Change"));
    await settle();
    expect(posted.at(-1)!.body).toEqual({ undoId: "undo-turn" });
    expect(editCard(root, "toolu_3").getAttribute("data-state")).toBe("unknown");
  });

  it("shows the newer preview instead of writing when a file moved on since", async () => {
    let applied = 0;
    answers["revert-turn"] = (body: { apply?: unknown }) => {
      if (body.apply) applied++;
      return {
        ...(body.apply ? { stale: true } : {}),
        files: [{ path: "/work/proj/src/a.ts", version: body.apply ? "va2" : "va", action: "edit", changes: 1, added: 1, removed: 0, skipped: [] }],
      };
    };
    const root = await render();
    await click(pill(root));
    await click(byText(root, "Revert turn…"));
    await settle();
    await click(byText(root.querySelector("[data-testid=revert-turn-confirm]")!, "Revert turn"));
    await settle();
    expect(applied).toBe(1);
    const confirm = root.querySelector("[data-testid=revert-turn-confirm]")!;
    expect(confirm.textContent).toContain("A file changed since");
    await click(byText(confirm, "Revert turn"));
    await settle();
    expect((posted.at(-1)!.body.apply as { version: string }[])[0]!.version).toBe("va2");
  });
});

describe("the change sheet on a phone", () => {
  beforeEach(() => Object.defineProperty(window, "innerWidth", { value: 390, configurable: true }));

  it("answers under each edit and for the whole turn with full-size buttons", async () => {
    const root = await render();
    await click(pill(root));
    const sheet = document.body.querySelector("[data-testid=turn-change-sheet]")!;
    const keepAll = byText(sheet, "Keep all 2")!;
    expect(keepAll.className).toContain("h-11");
    expect(byText(editCard(sheet, "toolu_1"), "Keep")!.className).toContain("h-11");
    expect(byText(editCard(sheet, "toolu_1"), "Chat")!.className).toContain("min-h-11");
    await click(byText(sheet, "Revert turn…"));
    await settle();
    expect(document.body.querySelector("[data-testid=turn-change-sheet] h4")!.textContent).toBe("Revert Turn 1?");
    expect(byText(document.body.querySelector("[data-testid=turn-change-sheet]")!, "Cancel")!.className).toContain("h-11");
  });
});
