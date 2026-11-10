/**
 * The morning digest against fakes: it fires at the user's time, asks only managers whose switch
 * is on, puts the answers on one card (partial at the deadline), refuses a late answer, never asks
 * twice across restarts, catches up a missed morning within three hours and skips it after.
 */
import { describe, expect, it } from "bun:test";
import { createAssistantDigest, DIGEST_ANSWER_WINDOW_MS, type DigestDeps, type DigestManager } from "../../../../src/services/assistant-digest/assistant-digest.service.ts";
import { buildDigestCard } from "../../../../src/services/assistant-digest/digest-card-assembly.ts";
import { parseDigestRun, type DigestRun } from "../../../../src/services/assistant-digest/digest-state.ts";
import { DIGEST_CLOSED, DIGEST_NOT_ASKED } from "../../../../src/services/assistant-cards/manager-report-tool.ts";
import type { NewCard } from "../../../../src/services/assistant-cards/assistant-cards.service.ts";

const ZONE = "Asia/Ho_Chi_Minh";
const AT_0759 = Date.parse("2026-11-10T00:59:00Z"); // 07:59 in Saigon

const mgr = (key: string, over: Partial<DigestManager> = {}): DigestManager => ({
  projectKey: key, projectName: key, projectPath: `/p/${key}`, sessionId: `s-${key}`, providerId: "claude", digest: true, titleOnly: false, ...over,
});

function harness(opts: { now?: number; managers?: DigestManager[]; main?: string | null; busy?: string[]; enabled?: boolean } = {}) {
  let now = opts.now ?? AT_0759;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  let stored: string | null = null;
  const asks: string[] = [];
  const cards: Array<NewCard & { id: string }> = [];
  let bound: ((id: string) => void) | null = null;
  const managers = opts.managers ?? [mgr("api"), mgr("web")];
  const settings = { digest: { enabled: opts.enabled ?? true, time: "08:00" }, zone: ZONE };
  const deps: DigestDeps = {
    clock: { now: () => now, setTimer: (fn, ms) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; } },
    settings: () => settings,
    managers: () => managers,
    mainSession: () => (opts.main === undefined ? "assistant-1" : opts.main),
    state: { read: () => parseDigestRun(stored), write: (run) => { stored = JSON.stringify(run); } },
    deliverAsk: async (m) => {
      asks.push(m.projectKey);
      return { clientMessageId: `ask-${m.projectKey}-${asks.length}`, started: !(opts.busy ?? []).includes(m.projectKey) };
    },
    onTurnBound: (fn) => { bound = fn; return () => { bound = null; }; },
    existingCard: (date) => cards.find((c) => c.payload?.date === date)?.id ?? null,
    createCard: (card) => { const made = { ...card, id: `card-${cards.length + 1}` }; cards.push(made); return made; },
    canonical: (id) => id,
  };
  const digest = createAssistantDigest(deps);
  const advance = async (ms: number) => {
    now += ms;
    for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn(); }
    await digest.settled();
  };
  const run = (): DigestRun | null => parseDigestRun(stored);
  return { digest, deps, advance, asks, cards, run, settings, bind: (id: string) => bound?.(id), now: () => now };
}

describe("a day's digest", () => {
  it("asks every manager whose switch is on at the user's time, and makes one card once all answered", async () => {
    const h = harness({ managers: [mgr("api"), mgr("off", { digest: false }), mgr("web")] });
    await h.digest.start();
    expect(h.asks).toEqual([]);
    await h.advance(60_000);
    expect(h.asks).toEqual(["api", "web"]);
    expect(h.run()!.date).toBe("2026-11-10");
    expect(h.digest.answer("s-api", ["Release 2.14 waits on you"])).toEqual({ ok: true });
    expect(h.cards).toHaveLength(0);
    expect(h.digest.answer("s-web", [])).toEqual({ ok: true });
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]).toMatchObject({ kind: "digest", wake: true, title: "Morning digest · 2 projects, 1 item" });
    expect(h.digest.answer("s-api", ["late"])).toEqual({ ok: false, message: DIGEST_CLOSED });
    expect(h.digest.answer("s-off", ["x"])).toEqual({ ok: false, message: DIGEST_NOT_ASKED });
    h.digest.stop();
  });

  it("puts a partial digest together at the deadline, the silent manager marked", async () => {
    const h = harness();
    await h.digest.start();
    await h.advance(60_000);
    h.digest.answer("s-api", ["one"]);
    h.digest.answer("s-api", ["two", "three"]);
    await h.advance(DIGEST_ANSWER_WINDOW_MS);
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]!.payload!.projects).toEqual([
      { name: "api", state: "answered", items: ["two", "three"] },
      { name: "web", state: "no_answer", items: [] },
    ]);
    h.digest.stop();
  });

  it("does nothing with no manager switched on, with no main session, or with the digest off", async () => {
    for (const h of [harness({ managers: [mgr("api", { digest: false })] }), harness({ main: null }), harness({ enabled: false })]) {
      await h.digest.start();
      await h.advance(60_000);
      expect(h.asks).toEqual([]);
      expect(h.run()).toBeNull();
      h.digest.stop();
    }
  });

  it("fires again the next day, and follows a time changed in Settings", async () => {
    const h = harness();
    await h.digest.start();
    await h.advance(60_000);
    await h.advance(DIGEST_ANSWER_WINDOW_MS);
    h.settings.digest = { enabled: true, time: "09:30" };
    h.digest.rearm();
    // Past 09:30 today (today's digest already ran) and 08:00 tomorrow: nothing new is asked.
    await h.advance(24 * 60 * 60_000); // 09:00 tomorrow
    expect(h.asks).toHaveLength(2);
    await h.advance(31 * 60_000);
    expect(h.asks).toHaveLength(4);
    expect(h.run()!.date).toBe("2026-11-11");
    h.digest.stop();
  });
});

describe("restarts", () => {
  it("asks each manager once across a crash loop of three starts", async () => {
    const h = harness({ now: Date.parse("2026-11-10T01:05:00Z") }); // 08:05: a start owes this morning
    for (let i = 0; i < 3; i++) {
      await h.digest.start();
      h.digest.stop();
    }
    expect(h.asks).toEqual(["api", "web"]);
  });

  it("hands an ask no turn took over once more, and never the one a turn took", async () => {
    const h = harness({ busy: ["web"] });
    await h.digest.start();
    await h.advance(60_000);
    expect(h.asks).toEqual(["api", "web"]);
    h.digest.stop();
    for (let i = 0; i < 2; i++) {
      await h.digest.start();
      h.digest.stop();
    }
    expect(h.asks).toEqual(["api", "web", "web"]);
  });

  it("does not hand over again an ask a turn took after it was queued", async () => {
    const h = harness({ busy: ["web"] });
    await h.digest.start();
    await h.advance(60_000);
    h.bind("ask-web-2");
    expect(h.run()!.taken.web).toBe(true);
    h.digest.stop();
    await h.digest.start();
    expect(h.asks).toEqual(["api", "web"]);
    h.digest.stop();
  });

  it("puts the digest together at startup when the deadline passed while PPM was off", async () => {
    const h = harness();
    await h.digest.start();
    await h.advance(60_000);
    h.digest.answer("s-api", ["one"]);
    h.digest.stop();
    await h.advance(2 * DIGEST_ANSWER_WINDOW_MS);
    await h.digest.start();
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]!.payload!.projects!.map((p) => p.state)).toEqual(["answered", "no_answer"]);
    h.digest.stop();
  });

  it("skips a morning PPM was off for more than three hours past", async () => {
    const h = harness({ now: Date.parse("2026-11-10T04:30:00Z") }); // 11:30 in Saigon
    await h.digest.start();
    expect(h.asks).toEqual([]);
    h.digest.stop();
  });
});

describe("pieces", () => {
  it("builds the card from partial answers, in asking order, title-only projects marked", () => {
    const run: DigestRun = {
      date: "2026-11-10", startedAt: 1, deadline: 2, asked: { b: "s-b", a: "s-a" }, names: { b: "pex", a: "nxsys" },
      delivered: {}, taken: {}, redelivered: {}, answers: { a: ["x", "y"] },
    };
    const card = buildDigestCard(run, (key) => key === "a");
    expect(card.title).toBe("Morning digest · 2 projects, 2 items");
    expect(card.payload!.projects).toEqual([
      { name: "pex", state: "no_answer", items: [] },
      { name: "nxsys", state: "answered", items: ["x", "y"], titleOnly: true },
    ]);
  });

  it("reads back only a run it wrote", () => {
    expect(parseDigestRun("not json")).toBeNull();
    expect(parseDigestRun(JSON.stringify({ date: "today", startedAt: 1, deadline: 2 }))).toBeNull();
    const run = parseDigestRun(JSON.stringify({ date: "2026-11-10", startedAt: 1, deadline: 2, answers: { a: ["x", 3] }, taken: { a: "yes" } }));
    expect(run).toMatchObject({ answers: { a: ["x"] }, taken: {}, asked: {} });
  });
});
