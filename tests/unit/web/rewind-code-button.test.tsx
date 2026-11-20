/**
 * "Rewind code" on a prompt: puts back what that turn and every later turn wrote, asked first and
 * undoable. Mounted against a fake server, because a rewind that posts one turn's calls instead of
 * all of them looks exactly like one that works.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, installGlobal, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { RewindCodeButton } = await import("../../../src/web/components/chat/rewind-code-button.tsx");
const { SessionChangesContext } = await import("../../../src/web/components/chat/session-changes-context.tsx");
const { useSessionTurnsStore } = await import("../../../src/web/stores/session-turns-store.ts");
const { sessionTurns, rewindFrom } = await import("../../../src/web/lib/session-turns.ts");
type ChatMessage = import("../../../src/types/chat.ts").ChatMessage;

const msg = (id: string, role: "user" | "assistant", content: string, calls: string[] = []): ChatMessage => ({
  id, role, content, timestamp: "2026-11-20T14:00:00.000Z",
  events: calls.map((toolUseId) => ({ type: "tool_use" as const, tool: "Edit", input: {}, toolUseId })),
});
const turns = sessionTurns([
  msg("u1", "user", "first"),
  msg("a1", "assistant", "", ["t1"]),
  msg("u2", "user", "second"),
  msg("a2", "assistant", "", ["t2", "t3"]),
  msg("u3", "user", "third"),
  msg("a3", "assistant", "", ["t4"]),
  msg("u4", "user", "just talk"),
  msg("a4", "assistant", "ok"),
]);

describe("rewindFrom", () => {
  it("takes the calls of the turn the message asked for and of every turn after it", () => {
    expect(rewindFrom(turns, "u2")).toEqual({ calls: ["t2", "t3", "t4"], turns: 2 });
    expect(rewindFrom(turns, "u1")).toEqual({ calls: ["t1", "t2", "t3", "t4"], turns: 3 });
    expect(rewindFrom(turns, "u4")).toEqual({ calls: [], turns: 0 });
    expect(rewindFrom(turns, "a2")).toBeNull();
  });
});

let posted: { url: string; body: Record<string, unknown> }[] = [];
let answers: Record<string, unknown> = {};
let refreshed = 0;

beforeEach(() => {
  posted = [];
  refreshed = 0;
  answers = { "revert-turn": { files: [] }, undo: { files: [] } };
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
const realWidth = window.innerWidth;
afterEach(async () => {
  await view?.unmount();
  view = null;
  Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
});

async function render(messageId: string, onFork?: () => void) {
  view = await mount(
    <SessionChangesContext.Provider value={{ projectName: "proj", sessionId: "s1", files: [], refresh: () => refreshed++, openReview: () => {} }}>
      <RewindCodeButton messageId={messageId} onFork={onFork} />
    </SessionChangesContext.Provider>,
  );
  return view.container;
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const byText = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.includes(text)) ?? null;
const dialog = () => document.querySelector<HTMLElement>("[data-testid=rewind-code-dialog]");
const preview = {
  files: [{ path: "/work/proj/src/a.ts", version: "va", action: "edit", changes: 2, added: 3, removed: 1, skipped: [] }],
};

describe("Rewind code", () => {
  it("is offered only where something was called from that message on", async () => {
    const root = await render("u4");
    expect(byText(root, "Rewind code")).toBeNull();
  });

  it("previews every later turn's calls, writes only once confirmed, then offers Undo", async () => {
    answers["revert-turn"] = (body: { apply?: unknown }) => (body.apply ? { files: preview.files, undoId: "undo-1" } : preview);
    const root = await render("u2");
    await click(byText(root, "Rewind code"));
    await settle();
    expect(posted.map((p) => p.body)).toEqual([{ calls: ["t2", "t3", "t4"] }]);
    expect(dialog()!.textContent).toContain("undoing what 2 turns wrote");
    expect(dialog()!.textContent).toContain("a.ts");

    await click(byText(dialog()!, "Rewind code")!);
    await settle();
    expect(posted[1]!.body).toEqual({ calls: ["t2", "t3", "t4"], apply: [{ path: "/work/proj/src/a.ts", version: "va" }] });
    expect(dialog()!.textContent).toContain("Rewound 1 file to before this message.");
    expect(refreshed).toBeGreaterThan(0);

    await click(byText(dialog()!, "Undo")!);
    await settle();
    expect(posted[2]!.url).toContain("/file-changes/undo");
    expect(posted[2]!.body).toEqual({ undoId: "undo-1" });
  });

  it("Rewind and fork forks once the files are back", async () => {
    answers["revert-turn"] = (body: { apply?: unknown }) => (body.apply ? { files: preview.files, undoId: "u" } : preview);
    let forked = 0;
    const root = await render("u3", () => forked++);
    await click(byText(root, "Rewind code"));
    await settle();
    await click(byText(dialog()!, "Rewind and fork")!);
    await settle();
    expect(posted[1]!.body).toEqual({ calls: ["t4"], apply: [{ path: "/work/proj/src/a.ts", version: "va" }] });
    expect(forked).toBe(1);
  });

  it("shows the newer preview when a file moved on, and writes nothing", async () => {
    answers["revert-turn"] = (body: { apply?: unknown }) => (body.apply ? { files: [{ ...preview.files[0], version: "vb" }], stale: true } : preview);
    const root = await render("u2");
    await click(byText(root, "Rewind code"));
    await settle();
    await click(byText(dialog()!, "Rewind code")!);
    await settle();
    expect(dialog()!.textContent).toContain("A file changed since");
    expect(byText(dialog()!, "Undo")).toBeNull();
  });

  it("opens as a bottom sheet on a phone", async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    answers["revert-turn"] = preview;
    const root = await render("u3");
    await click(byText(root, "Rewind code"));
    await settle();
    expect(dialog()!.closest("[role=dialog]")).toBeNull();
    expect(dialog()!.textContent).toContain("undoing what 1 turn wrote");
  });
});
