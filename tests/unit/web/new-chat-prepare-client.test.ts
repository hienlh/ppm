/**
 * `/chat/prepare` client: one POST per tab id, fanned out into every cache the parts of
 * a sessionless tab would otherwise fetch on their own.
 *
 * The request goes through the client's injected transport, and `localStorage` is an
 * in-memory stub installed through `installGlobal`, so this file's cache writes stay out
 * of the web storage the rest of the process shares and the real one comes back
 * afterwards. `window` is the process-wide DOM's own.
 */
import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { installGlobal, uninstallDom } from "../../helpers/react-dom.tsx";

const store = new Map<string, string>();
installGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  get length() { return store.size; },
  key: (i: number) => [...store.keys()][i] ?? null,
});

const { projectUrl } = await import("../../../src/web/lib/api-client");
const {
  startPrepare, getPrepare, isPrepared, forgetPrepare, prepareFoundNoAccount,
  __clearPrepareForTest, __setPrepareTransportForTest,
} = await import("../../../src/web/lib/new-chat-prepare-client");
const { readChatPreparationSettings, readChatProviders } = await import("../../../src/web/lib/chat-preference-local-cache");
const { peekChatProviders } = await import("../../../src/web/lib/chat-preparation-cache");
const { getCachedSlashItems } = await import("../../../src/web/lib/slash-items-cache");
const { useSessionListStore } = await import("../../../src/web/stores/session-list-store");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { projectCacheId } = await import("../../../src/web/lib/browser-cache/cache-keys");

afterAll(() => {
  __setPrepareTransportForTest(null);
  __clearPrepareForTest();
  uninstallDom();
});

const project = { name: "prep-proj", path: "/prep-proj" };

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    resolvedProviderId: "claude",
    providerId: "claude",
    settings: { default_provider: "claude", providers: { claude: { permission_mode: "acceptEdits" } } },
    providers: [{ id: "claude", name: "Claude" }],
    pickedAccount: { id: "acct-1", label: "Acct 1" },
    usage: { lastFetchedAt: "2026-01-01T00:00:00.000Z", sevenDay: 0.4 },
    draft: { content: "hello", attachments: "[]", updatedAt: "2026-01-01T00:00:00.000Z" },
    tags: { tags: [], counts: {}, defaultTagId: null },
    slash: { items: [{ type: "skill", name: "clear", description: "Clear" }], recentNames: [] },
    ...overrides,
  };
}

function withTab(id: string, metadata: Record<string, unknown> = {}) {
  usePanelStore.setState({
    currentProject: project.name, focusedPanelId: "main", grid: [["main"]], lastFocusedChatProviders: {},
    panels: { main: { id: "main", activeTabId: id, tabHistory: [id],
      tabs: [{ id, type: "chat", title: "Chat", projectId: project.name, closable: true, metadata }] } },
  } as never);
}
const meta = () => usePanelStore.getState().panels.main!.tabs[0]!.metadata!;

let calls: Array<{ path: string; body: unknown }> = [];
/** Answers every request with `next()`; records what was asked. */
function answerWith(next: () => Promise<unknown>) {
  __setPrepareTransportForTest(((path, body) => {
    calls.push({ path, body });
    return next();
  }) as Parameters<typeof __setPrepareTransportForTest>[0]);
}

beforeEach(() => {
  localStorage.removeItem("ppm-chat-pref");
  localStorage.removeItem(`ppm-chat-providers:${projectCacheId(project)}`);
  useSessionListStore.setState({ byProject: {} });
  __clearPrepareForTest();
  calls = [];
});
afterEach(() => { __setPrepareTransportForTest(null); });

it("fires exactly one POST per tab id and fans out into every cache it feeds", async () => {
  withTab("prep-a", { providerId: "claude" });
  answerWith(() => Promise.resolve(makeResult()));
  const first = startPrepare("prep-a", project, { providerId: "claude" });
  expect(startPrepare("prep-a", project, { providerId: "claude" })).toBe(first);
  await first;
  expect(calls).toHaveLength(1);
  expect(calls[0]!.path).toBe(`${projectUrl(project.name)}/chat/prepare`);

  expect(readChatPreparationSettings()).toEqual({
    default_provider: "claude", new_chat_provider_mode: undefined, providers: { claude: { permission_mode: "acceptEdits" } },
  });
  expect(readChatProviders(projectCacheId(project))).toEqual([{ id: "claude", name: "Claude" }]);
  expect(peekChatProviders(project.name)).toEqual([{ id: "claude", name: "Claude" }]);
  expect(getCachedSlashItems(project.name, "claude")?.items[0]?.name).toBe("clear");
  expect(useSessionListStore.getState().byProject[projectCacheId(project)]?.tags)
    .toEqual({ tags: [], counts: {}, defaultTagId: null });
  expect(meta()).toMatchObject({ pickedAccountId: "acct-1", pickedAccountLabel: "Acct 1", pickedAccountProvider: "claude" });
});

it("passes skipPick through to the request body untouched", async () => {
  withTab("prep-b");
  answerWith(() => Promise.resolve(makeResult()));
  await startPrepare("prep-b", project, { providerId: "claude", skipPick: true });
  expect(calls[0]!.body).toEqual({ providerId: "claude", skipPick: true });
});

it("does not write a claim for \"timeout\" or \"skipped\"", async () => {
  withTab("prep-c");
  answerWith(() => Promise.resolve(makeResult({ pickedAccount: "timeout", usage: null })));
  await startPrepare("prep-c", project, { providerId: "claude" });
  expect(meta().pickedAccountId).toBeUndefined();

  withTab("prep-c2");
  answerWith(() => Promise.resolve(makeResult({ pickedAccount: "skipped", usage: null })));
  await startPrepare("prep-c2", project, { providerId: "claude", skipPick: true });
  expect(meta().pickedAccountId).toBeUndefined();
});

it("getPrepare answers undefined for a tab nothing started, or no tab id at all", () => {
  expect(getPrepare("never-started")).toBeUndefined();
  expect(getPrepare(undefined)).toBeUndefined();
});

it("remembers a tab as prepared only once its prepare succeeded", async () => {
  withTab("prep-d", { providerId: "claude" });
  answerWith(() => Promise.reject(new Error("offline")));
  await startPrepare("prep-d", project, { providerId: "claude" }).catch(() => {});
  expect(isPrepared("prep-d")).toBe(false);

  withTab("prep-d2", { providerId: "claude" });
  answerWith(() => Promise.resolve(makeResult()));
  await startPrepare("prep-d2", project, { providerId: "claude" });
  expect(isPrepared("prep-d2")).toBe(true);
});

it("records a null pick as final for that provider, but not a timed-out one", async () => {
  withTab("prep-e", { providerId: "claude" });
  answerWith(() => Promise.resolve(makeResult({ pickedAccount: null, usage: null })));
  await startPrepare("prep-e", project, { providerId: "claude" });
  expect(prepareFoundNoAccount("prep-e", "claude")).toBe(true);
  expect(prepareFoundNoAccount("prep-e", "codex")).toBe(false);
  expect(meta().pickedAccountId).toBeUndefined();

  withTab("prep-e2", { providerId: "claude" });
  answerWith(() => Promise.resolve(makeResult({ pickedAccount: "timeout", usage: null })));
  await startPrepare("prep-e2", project, { providerId: "claude" });
  expect(prepareFoundNoAccount("prep-e2", "claude")).toBe(false);
});

it("forgetPrepare drops the join, the prepared flag and the null pick together", async () => {
  withTab("prep-f", { providerId: "claude" });
  answerWith(() => Promise.resolve(makeResult({ pickedAccount: null, usage: null })));
  await startPrepare("prep-f", project, { providerId: "claude" });
  forgetPrepare("prep-f");
  expect(getPrepare("prep-f")).toBeUndefined();
  expect(isPrepared("prep-f")).toBe(false);
  expect(prepareFoundNoAccount("prep-f", "claude")).toBe(false);

  // The next sessionless stretch asks again, on a request of its own.
  await startPrepare("prep-f", project, { providerId: "claude" });
  expect(calls).toHaveLength(2);
});

it("a prepare that lands after the tab was forgotten claims nothing for it", async () => {
  withTab("prep-g", { providerId: "claude" });
  let answer!: (value: unknown) => void;
  answerWith(() => new Promise((resolve) => { answer = resolve; }));
  const pending = startPrepare("prep-g", project, { providerId: "claude" });
  forgetPrepare("prep-g");
  answer(makeResult());
  await pending;
  expect(meta().pickedAccountId).toBeUndefined();
  expect(isPrepared("prep-g")).toBe(false);
});

it("a failed prepare rejects only for whoever awaits it — nothing is left unhandled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    withTab("prep-h", { providerId: "claude" });
    answerWith(() => Promise.reject(new Error("prepare failed")));
    await expect(startPrepare("prep-h", project, { providerId: "claude" })).rejects.toThrow("prepare failed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
