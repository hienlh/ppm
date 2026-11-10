/**
 * The morning digest end to end in one process: the real chat socket layer runs two manager chats
 * and the main Assistant session, a scripted Claude stands in for the CLI (a `later` message waits
 * for the running turn, as the CLI's input queue does, and dies with the CLI), the real
 * `/api/sessions-mcp` endpoint takes the digest answers, and time is a fake clock.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { providerRegistry } from "../../src/providers/registry.ts";
import { configService } from "../../src/services/config.service.ts";
import { chatService } from "../../src/services/chat.service.ts";
import { getDb, setSessionAssistant, setSessionMetadata, setSessionProvider, setSessionTitle } from "../../src/services/db.service.ts";
import { chatControl } from "../../src/services/chat-control/chat-control.ts";
import { managerChats } from "../../src/services/assistant-managers/manager-chats.service.ts";
import { clearMainSessionIf, setMainSession } from "../../src/services/assistant/assistant-main-session.ts";
import { sessionCollabMcpHandler } from "../../src/services/session-collab/session-collab-endpoint.ts";
import { sessionCollabMcpTokens } from "../../src/services/session-collab/session-collab-tokens.ts";
import { setAssistantClock } from "../../src/services/assistant-wake/assistant-clock.ts";
import { assistantWakeQueue } from "../../src/services/assistant-wake/assistant-wake-queue.ts";
import { NEWS_OPENER } from "../../src/services/assistant-wake/wake-news-text.ts";
import { startAssistantCards, stopAssistantCards } from "../../src/services/assistant-cards/assistant-cards-startup.ts";
import { cardOutbound } from "../../src/services/assistant-cards/card-outbound.ts";
import { assistantDigest, DIGEST_ASK_TEXT, startAssistantDigest, stopAssistantDigest } from "../../src/services/assistant-digest/assistant-digest-env.ts";
import { DIGEST_STATE_ROW } from "../../src/services/assistant-digest/digest-state.ts";
import { DIGEST_ANSWER_WINDOW_MS } from "../../src/services/assistant-digest/assistant-digest.service.ts";
import { ASSISTANT_PROJECT_NAME } from "../../src/shared/assistant-project.ts";
import type { AssistantCard } from "../../src/shared/assistant-cards.ts";
import type { AIProvider } from "../../src/providers/provider.interface.ts";
import type { PpmConfig } from "../../src/types/config.ts";
import { ScriptedCli } from "./fixtures/scripted-cli-provider.ts";

const claude = new ScriptedCli();
let original: AIProvider | undefined;
const home = process.env.PPM_HOME!;
const paths = { a: join(home, "dg-a"), b: join(home, "dg-b") };
const app = new Hono();
app.all("/mcp", sessionCollabMcpHandler);
let projectsBefore: PpmConfig["projects"] = [];
let assistantBefore: unknown;
let mgrA = "";
let mgrB = "";
let assistant = "";

// 07:59 in Asia/Ho_Chi_Minh on 10 November 2026; every test starts on a morning of its own.
const BASE = Date.UTC(2026, 10, 10, 0, 59);
const DAY = 24 * 60 * 60_000;
let clock = BASE;
let day = 0;
const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
const advance = async (ms: number) => {
  clock += ms;
  for (const t of timers) if (t.live && t.at <= clock) { t.live = false; t.fn(); }
  await assistantDigest.settled();
};

async function chatOf(project: string, path: string, title: string): Promise<string> {
  const { id } = await chatService.createSession("claude", {});
  setSessionMetadata(id, project, path);
  setSessionProvider(id, "claude");
  setSessionTitle(id, title);
  return id;
}

beforeAll(async () => {
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  original = providerRegistry.get("claude");
  providerRegistry.register(claude as never);
  const saved = configService.get("assistant");
  assistantBefore = saved === undefined ? undefined : structuredClone(saved);
  setAssistantClock({ now: () => clock, setTimer: (fn, ms) => { const t = { at: clock + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; } });
  projectsBefore = [...configService.get("projects")];
  configService.set("projects", [...projectsBefore, { name: "dg-a", path: paths.a }, { name: "dg-b", path: paths.b }]);
  await import("../../src/server/ws/chat.ts");
  mgrA = await chatOf("dg-a", paths.a, "Manager A");
  mgrB = await chatOf("dg-b", paths.b, "Manager B");
  await managerChats.assign("dg-a", mgrA, "user");
  await managerChats.assign("dg-b", mgrB, "user");
  assistant = `asst-${crypto.randomUUID()}`;
  setSessionMetadata(assistant, ASSISTANT_PROJECT_NAME, join(home, "dg-assistant"));
  setSessionProvider(assistant, "claude");
  setSessionAssistant(assistant);
  setMainSession(assistant);
  startAssistantCards();
});

afterAll(() => {
  stopAssistantDigest();
  stopAssistantCards();
  assistantWakeQueue.stop();
  clearMainSessionIf(assistant);
  if (assistantBefore !== undefined) configService.set("assistant", assistantBefore as never);
  managerChats.unassign("dg-a");
  managerChats.unassign("dg-b");
  configService.set("projects", projectsBefore);
  claude.releaseAll();
  setAssistantClock(null);
  if (original) providerRegistry.register(original);
});

const until = async (check: () => unknown, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};
const ctl = () => chatControl()!;
const idle = (id: string) => until(() => (ctl().liveState(id)?.phase ?? "idle") === "idle", `${id} idle`);
const asksTo = (id: string) => claude.received.filter((r) => r.sessionId === id && r.message.includes(DIGEST_ASK_TEXT));
const wakeTurns = () => claude.received.filter((r) => r.sessionId === assistant && r.message.includes(NEWS_OPENER));
type StoredDigest = Pick<AssistantCard, "id" | "title" | "payload"> & { outbound: string };
const digestCards = (): StoredDigest[] =>
  (getDb().query("SELECT id, title, payload_json, outbound FROM assistant_cards WHERE kind = 'digest' ORDER BY created_at").all() as
    Array<{ id: string; title: string; payload_json: string; outbound: string }>)
    .map((r) => ({ id: r.id, title: r.title, payload: JSON.parse(r.payload_json) as AssistantCard["payload"], outbound: r.outbound }));

async function answer(sessionId: string, items: string[]) {
  const token = sessionCollabMcpTokens.mint({ sessionId });
  const res = await app.request("/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_to_assistant", arguments: { kind: "digest", title: "Status", items } } }),
  });
  const result = (await res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { text: result.content[0]!.text, isError: result.isError === true };
}

/** A new morning at 07:59, nothing left of the last one, the digest (re)started with these settings. */
async function morning(over: Record<string, unknown> = {}, minute = 0): Promise<void> {
  stopAssistantDigest();
  getDb().run("DELETE FROM assistant_cards");
  getDb().query("DELETE FROM config WHERE key = ?").run(DIGEST_STATE_ROW);
  clock = BASE + ++day * DAY + minute * 60_000;
  configService.set("assistant", {
    ...(configService.get("assistant") ?? {}), timezone: "Asia/Ho_Chi_Minh",
    digest: { enabled: true, time: "08:00" }, quiet_hours: { enabled: false, start: "22:00", end: "07:00" }, ...over,
  } as never);
  await startAssistantDigest();
}

describe("the morning digest", () => {
  it("asks an idle manager at once and a busy one only after its turn, never inside it", async () => {
    await morning();
    await ctl().sendUserMessage(mgrB, "HOLD the release", { origin: "telegram", projectName: "dg-b", providerId: "claude" });
    await until(() => claude.log.includes(`start:${mgrB}:hold`), "the busy turn");
    await advance(60_000);
    await until(() => claude.log.includes(`start:${mgrA}:ask`), "the idle manager's ask");
    expect(asksTo(mgrB)).toHaveLength(1);
    expect(asksTo(mgrB).at(-1)!.priority).toBe("later");
    expect(claude.log).not.toContain(`mid:${mgrB}`);
    expect(claude.log).not.toContain(`start:${mgrB}:ask`);
    claude.release(mgrB);
    await until(() => claude.log.includes(`start:${mgrB}:ask`), "the busy manager's ask");
    expect(claude.log.indexOf(`start:${mgrB}:ask`)).toBeGreaterThan(claude.log.indexOf(`done:${mgrB}:hold`));
    await idle(mgrA);
    await idle(mgrB);

    const wakes = wakeTurns().length;
    expect((await answer(mgrA, ["Release 2.14 waits on you"])).isError).toBe(false);
    expect(digestCards()).toHaveLength(0);
    expect((await answer(mgrB, ["PR #50 reviewed", "Nothing blocked"])).isError).toBe(false);
    const cards = digestCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.title).toBe("Morning digest · 2 projects, 3 items");
    expect(cards[0]!.payload.projects!.map((p) => [p.name, p.state, p.items.length])).toEqual([["dg-a", "answered", 1], ["dg-b", "answered", 2]]);
    await until(() => wakeTurns().length === wakes + 1, "one wake");
    expect(wakeTurns().at(-1)!.opts?.sharedContext).toContain("morning digest");
    await idle(assistant);
    await Bun.sleep(30);
    expect(wakeTurns()).toHaveLength(wakes + 1);
    expect((await answer(mgrA, ["late"])).text).toContain("already put together");
  });

  it("at the deadline shows a manager that did not answer as such", async () => {
    await morning();
    const b = asksTo(mgrB).length;
    await advance(60_000);
    await until(() => asksTo(mgrB).length === b + 1, "both asked");
    await idle(mgrB);
    await answer(mgrA, ["One thing"]);
    await advance(DIGEST_ANSWER_WINDOW_MS);
    const [card] = digestCards();
    expect(card!.payload.projects!.map((p) => [p.name, p.state])).toEqual([["dg-a", "answered"], ["dg-b", "no_answer"]]);
    await idle(assistant);
  });

  it("does not ask a project whose switch is off", async () => {
    managerChats.patch("dg-b", { digest: false });
    try {
      await morning();
      const before = asksTo(mgrB).length;
      const a = asksTo(mgrA).length;
      await advance(60_000);
      await until(() => asksTo(mgrA).length === a + 1, "A asked");
      await answer(mgrA, []);
      expect(asksTo(mgrB)).toHaveLength(before);
      expect(digestCards()[0]!.payload.projects!.map((p) => p.name)).toEqual(["dg-a"]);
      await idle(mgrA);
      await idle(assistant);
    } finally {
      managerChats.patch("dg-b", { digest: true });
    }
  });
});

describe("restarts", () => {
  it("puts a run left mid-collection together at startup once its deadline passed", async () => {
    await morning();
    await advance(60_000);
    await answer(mgrA, ["Answered before the restart"]);
    stopAssistantDigest();
    await advance(2 * DIGEST_ANSWER_WINDOW_MS);
    expect(digestCards()).toHaveLength(0);
    await startAssistantDigest();
    const [card] = digestCards();
    expect(card!.payload.projects!.map((p) => p.state)).toEqual(["answered", "no_answer"]);
    await idle(mgrA);
    await idle(mgrB);
    await idle(assistant);
  });

  it("hands an ask the CLI lost over once more, and never asks the other manager twice", async () => {
    await morning();
    const a = asksTo(mgrA).length;
    const b = asksTo(mgrB).length;
    await ctl().sendUserMessage(mgrB, "HOLD the deploy", { origin: "telegram", projectName: "dg-b", providerId: "claude" });
    await until(() => claude.log.filter((l) => l === `start:${mgrB}:hold`).length > 0 && claude.running(mgrB), "the busy turn");
    await advance(60_000);
    await until(() => asksTo(mgrB).length === b + 1, "the queued ask");
    stopAssistantDigest();
    claude.kill(mgrB); // The CLI dies, and the queued ask with it.
    await idle(mgrB);
    for (let i = 0; i < 3; i++) {
      await startAssistantDigest();
      stopAssistantDigest();
    }
    await until(() => asksTo(mgrB).length === b + 2, "the ask handed over again");
    await Bun.sleep(30);
    expect(asksTo(mgrB)).toHaveLength(b + 2);
    expect(asksTo(mgrA)).toHaveLength(a + 1);
    await idle(mgrA);
    await idle(mgrB);
  });

  it("asks each manager once across a crash loop of three starts after a missed time", async () => {
    const a = asksTo(mgrA).length;
    const b = asksTo(mgrB).length;
    await morning({}, 6); // 08:05: the server was off at 08:00, so this first start owes the morning
    for (let i = 0; i < 3; i++) {
      await startAssistantDigest();
      stopAssistantDigest();
    }
    await until(() => asksTo(mgrA).length === a + 1 && asksTo(mgrB).length === b + 1, "both asked");
    await idle(mgrA);
    await idle(mgrB);
    expect(asksTo(mgrA)).toHaveLength(a + 1);
    expect(asksTo(mgrB)).toHaveLength(b + 1);
  });
});

describe("quiet hours", () => {
  it("holds a digest that comes in quiet hours until they end", async () => {
    await morning({ quiet_hours: { enabled: true, start: "07:00", end: "09:30" } });
    const sent: Array<{ ids: string[]; header?: string }> = [];
    const sink = { ready: () => true, send: (cards: AssistantCard[], header?: string) => sent.push({ ids: cards.map((c) => c.id), header }), changed: () => {} };
    cardOutbound.attach(sink);
    try {
      await advance(60_000);
      await answer(mgrA, ["a"]);
      await answer(mgrB, ["b"]);
      const [card] = digestCards();
      expect(card!.outbound).toBe("held");
      expect(sent).toEqual([]);
      await advance(90 * 60_000);
      expect(sent).toEqual([{ ids: [card!.id], header: "While you were away: 1 item" }]);
    } finally {
      cardOutbound.detach(sink);
      stopAssistantDigest();
    }
  });
});
