import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act, StrictMode, useState } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
// Dynamic, and after installDom(): useDraft now reaches new-chat-prepare-client.ts,
// which (via the account-claim hook) transitively imports panel-store.ts — and that
// reads `localStorage` at import time. A static import above would have run before
// installDom() ever executed, since ES imports are hoisted ahead of a module's own
// top-level statements.
const { useDraft } = await import("../../../src/web/hooks/use-draft");
const { api } = await import("../../../src/web/lib/api-client");
const { startPrepare, __clearPrepareForTest } = await import("../../../src/web/lib/new-chat-prepare-client");
let view: Mounted | null = null;
let current: ReturnType<typeof useDraft>;
let selectSession: (id: string | null) => void;
const spies: Array<{ mockRestore(): void }> = [];
function Harness({ session = null, tab = "tab-a", project = "project" }: { session?: string | null; tab?: string; project?: string }) {
  const [id, setId] = useState(session);
  selectSession = setId;
  current = useDraft(project, id, tab || undefined);
  return <div>{current.draft?.content}</div>;
}
beforeEach(() => {
  spies.push(spyOn(api, "get").mockResolvedValue(null), spyOn(api, "put").mockResolvedValue({}), spyOn(api, "del").mockResolvedValue(undefined));
});
afterEach(async () => {
  await view?.unmount(); view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  sessionStorage.clear();
  __clearPrepareForTest();
  localStorage.clear();
});
async function remount(element: React.ReactNode) {
  await view?.unmount();
  view = await mount(element);
}
it("preserves a newer local draft across StrictMode reload and a stale server draft", async () => {
  view = await mount(<Harness />);
  await act(async () => { current.saveDraft("unsaved text"); current.cancelPendingSave(); });
  spies.push(spyOn(api, "get").mockResolvedValue({ content: "old server text", attachments: "[]" }));
  await remount(<StrictMode><Harness /></StrictMode>);
  expect(view!.container.textContent).toBe("unsaved text");
});
it("does not recover another session, tab or project's draft", async () => {
  view = await mount(<Harness session="a" />);
  await act(async () => { current.saveDraft("only a"); current.cancelPendingSave(); selectSession("b"); });
  await remount(<Harness session="b" />);
  expect(current.draft).toBeNull();
  await remount(<Harness session="a" tab="tab-b" />);
  expect(current.draft).toBeNull();
  await remount(<Harness session="a" project="another" />);
  expect(current.draft).toBeNull();
  await remount(<Harness session="a" />);
  expect(current.draft?.content).toBe("only a");
});
for (const tab of ["tab-a", ""]) it(`moves a pending first draft and clears both owners after send (${tab || "no tab id"})`, async () => {
  view = await mount(<Harness tab={tab} />);
  await act(async () => {
    current.saveDraft("pending"); current.cancelPendingSave();
    current.moveDraft("created"); selectSession("created");
  });
  await remount(<Harness tab={tab} session="created" />);
  expect(current.draft?.content).toBe("pending");
  await act(async () => { current.clearDraft("__new__"); });
  await remount(<Harness tab={tab} />);
  expect(current.draft).toBeNull();
  await remount(<Harness tab={tab} session="created" />);
  expect(current.draft).toBeNull();
});

it("joins the tab's own prepare for a brand-new draft, without a separate GET", async () => {
  const get = spyOn(api, "get");
  const post = spyOn(api, "post").mockResolvedValue({
    resolvedProviderId: "claude", providerId: "claude",
    settings: { default_provider: "claude", providers: {} }, providers: [],
    pickedAccount: null, usage: null,
    draft: { content: "from prepare", attachments: "[]", updatedAt: "" },
    tags: null, slash: { items: [], recentNames: [] },
  });
  startPrepare("prepare-tab", { name: "project", path: "project" }, { providerId: "claude" });
  view = await mount(<Harness tab="prepare-tab" />);
  await act(async () => {});
  expect(current.draft?.content).toBe("from prepare");
  expect(get).not.toHaveBeenCalled();
  post.mockRestore(); get.mockRestore();
});

it("a recovered local draft still wins over a fresher prepare draft after a reload", async () => {
  view = await mount(<Harness tab="prepare-tab-2" />);
  await act(async () => { current.saveDraft("unsaved text"); current.cancelPendingSave(); });
  const post = spyOn(api, "post").mockResolvedValue({
    resolvedProviderId: "claude", providerId: "claude",
    settings: { default_provider: "claude", providers: {} }, providers: [],
    pickedAccount: null, usage: null,
    draft: { content: "stale prepare draft", attachments: "[]", updatedAt: "" },
    tags: null, slash: { items: [], recentNames: [] },
  });
  startPrepare("prepare-tab-2", { name: "project", path: "project" }, { providerId: "claude" });
  await remount(<Harness tab="prepare-tab-2" />);
  expect(current.draft?.content).toBe("unsaved text");
  post.mockRestore();
});


it("restores a reply draft when switching away and back without a remount", async () => {
  const { encodeReply } = await import("../../../src/shared/chat-reply");
  const reply = { version: 1 as const, sessionId: "a", providerId: "codex", messageId: "m", role: "assistant" as const,
    timestamp: "2026-10-01T00:00:00Z", quote: "source", truncated: false };
  sessionStorage.setItem(`ppm-chat-draft:${JSON.stringify(["project", "tab-a", "a"])}`,
    JSON.stringify({ content: encodeReply("draft a", reply), attachments: [] }));
  view = await mount(<Harness session="a" />);
  expect(current.draft?.replyTo).toEqual(reply);
  await act(async () => { selectSession("b"); });
  expect(current.draft).toBeNull();
  await act(async () => { selectSession("a"); });
  expect(current.draft?.content).toBe("draft a");
  expect(current.draft?.replyTo).toEqual(reply);
});

it("a debounced save stays with the session that owned its reply", async () => {
  const put = spyOn(api, "put").mockResolvedValue({});
  const reply = { version: 1 as const, sessionId: "a", providerId: "codex", messageId: "m", role: "assistant" as const,
    timestamp: "2026-10-01T00:00:00Z", quote: "source", truncated: false };
  view = await mount(<Harness session="a" />);
  await act(async () => { current.saveDraft("draft a", [], reply); selectSession("b"); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
  expect(put.mock.calls).toHaveLength(1);
  expect(put.mock.calls[0]![0]).toContain("/drafts/a");
  const { decodeReply } = await import("../../../src/shared/chat-reply");
  expect(decodeReply((put.mock.calls[0]![1] as { content: string }).content).replyTo).toEqual(reply);
  put.mockRestore();
});
