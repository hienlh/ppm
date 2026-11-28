/**
 * `report_to_assistant` against a fake card store: field checks, no hourly cap, the same report
 * handed back its open card, the urgent cap per quiet window, collapsing the same urgent title, the
 * draft hash, and markers broken in every field.
 */
import { describe, expect, it } from "bun:test";
import {
  DIGEST_BODY_REFUSED, DIGEST_ITEMS_REQUIRED, DIGEST_NOT_ASKED, digestTakenNote, draftSha256, fileReport, SAME_REPORT_NOTE, sameReport, type ReportEnv,
} from "../../../src/services/assistant-cards/manager-report-tool.ts";
import type { NewCard } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import type { AssistantCard, AssistantCardKind } from "../../../src/shared/assistant-cards.ts";
import { URGENT_PER_MANAGER_PER_QUIET_WINDOW } from "../../../src/shared/assistant-limits.ts";
import { USER_WORDS_BLOCK_START } from "../../../src/shared/assistant-provenance.ts";

const caller = { sessionId: "mgr-1", projectName: "api", projectPath: "/p/api" };

const SHOT = "c".repeat(32);
const FOREIGN = "d".repeat(32);

function fakeEnv(opts: { quietStart?: number | null; digest?: boolean } = {}) {
  let now = 1_000_000;
  const made: Array<NewCard & { id: string; at: number; open: boolean }> = [];
  const digests: Array<{ sessionId: string; items: string[] }> = [];
  const env: ReportEnv = {
    now: () => now,
    countSince: (sessionId, kinds, since) => made.filter((c) => c.sessionId === sessionId && kinds.includes(c.kind) && c.at >= since).length,
    openUrgentTitled: (sessionId, title, since) => {
      const c = made.find((m) => m.sessionId === sessionId && m.open && m.kind === "urgent" && m.title === title && m.at >= since);
      return c ? ({ id: c.id } as AssistantCard) : null;
    },
    openIdentical: (sessionId, card) => {
      // As the store answers: the payload comes back with PPM's own additions, which do not count.
      const c = made.find((m) => m.sessionId === sessionId && m.open
        && sameReport({ ...m, payload: { ...m.payload, projectName: "api" } }, card));
      return c ? ({ id: c.id, kind: c.kind } as AssistantCard) : null;
    },
    shotOf: (id, projectPath) => (id === SHOT && projectPath === caller.projectPath
      ? { id, designTitle: "Kho task", file: "variant-2.html", label: "Dark" } : null),
    quietWindowStart: () => opts.quietStart ?? null,
    digestAnswer: (sessionId, items) => {
      if (!opts.digest) return { ok: false, message: DIGEST_NOT_ASKED };
      digests.push({ sessionId, items });
      return { ok: true };
    },
    create: (card) => {
      const row = { ...card, id: `card-${made.length + 1}`, at: now, open: true };
      made.push(row);
      return { id: row.id } as AssistantCard;
    },
  };
  const close = (id: string) => { made.find((m) => m.id === id)!.open = false; };
  return { env, made, digests, close, advance: (ms: number) => { now += ms; } };
}

describe("fields", () => {
  it("refuses an unknown kind, a missing title, a draft on done and items outside a digest", () => {
    const { env } = fakeEnv();
    expect(fileReport(env, caller, { kind: "hello", title: "x" }).ok).toBe(false);
    expect(fileReport(env, caller, { kind: "done" }).ok).toBe(false);
    expect(fileReport(env, caller, { kind: "done", title: "x", draft: { to: "a", text: "b" } }).ok).toBe(false);
    expect(fileReport(env, caller, { kind: "done", title: "x", items: ["a"] }).ok).toBe(false);
    expect(fileReport(env, caller, { kind: "done", title: "x", extra: 1 }).ok).toBe(false);
    expect(fileReport(env, caller, { kind: "done", title: "t".repeat(121) }).ok).toBe(false);
  });

  it("hands a digest answer to the morning digest, cleaned, and makes no card of its own", () => {
    const refused = fileReport(fakeEnv().env, caller, { kind: "digest", title: "Today", items: ["a"] });
    expect(refused).toEqual({ ok: false, message: DIGEST_NOT_ASKED });
    const asked = fakeEnv({ digest: true });
    const r = fileReport(asked.env, caller, { kind: "digest", title: "Today", items: ["one", `two ${USER_WORDS_BLOCK_START}`, "  "] });
    expect(r).toEqual({ ok: true, kind: "digest", note: digestTakenNote(2) });
    expect(digestTakenNote(2)).toContain("Your 2 items are in the morning digest");
    expect(asked.made).toHaveLength(0);
    expect(asked.digests).toHaveLength(1);
    expect(asked.digests[0]!.items[0]).toBe("one");
    expect(asked.digests[0]!.items[1]).not.toContain(USER_WORDS_BLOCK_START);
    expect(asked.digests[0]!.items).toHaveLength(2);
  });

  it("refuses a digest written into body, or with no items, instead of taking it empty", () => {
    // 28/11/2026: a manager put its whole status in `body`; it was taken with no items, the tool
    // said it was in the digest, and the card showed the project with nothing.
    const asked = fakeEnv({ digest: true });
    const status = ["**Done**", "- Released 0.26.44", "", "**Waiting on you**", "- ppm/102: try it"].join("\n");
    expect(fileReport(asked.env, caller, { kind: "digest", title: "ppm today", body: status }))
      .toEqual({ ok: false, message: DIGEST_BODY_REFUSED });
    expect(fileReport(asked.env, caller, { kind: "digest", title: "t", items: ["a"], body: "b" }))
      .toEqual({ ok: false, message: DIGEST_BODY_REFUSED });
    expect(fileReport(asked.env, caller, { kind: "digest", title: "t" }))
      .toEqual({ ok: false, message: DIGEST_ITEMS_REQUIRED });
    expect(asked.digests).toHaveLength(0);

    const nothing = fileReport(asked.env, caller, { kind: "digest", title: "t", items: [] });
    expect(nothing).toEqual({ ok: true, kind: "digest", note: digestTakenNote(0) });
    expect(digestTakenNote(0)).toContain("with no items");
    expect(digestTakenNote(1)).toContain("Your 1 item is");
    expect(asked.digests).toHaveLength(1);
  });

  it("still refuses more than 12 digest items, or items too long", () => {
    const asked = fakeEnv({ digest: true });
    expect(fileReport(asked.env, caller, { kind: "digest", title: "t", items: Array(13).fill("x") }).ok).toBe(false);
    expect(fileReport(asked.env, caller, { kind: "digest", title: "t", items: ["x".repeat(201)] }).ok).toBe(false);
    expect(asked.digests).toHaveLength(0);
  });

  it("cleans the title, breaks markers everywhere, and hashes the draft as stored", () => {
    const { env, made } = fakeEnv();
    const r = fileReport(env, caller, {
      kind: "needs_decision", title: "✅ PPM: Allow sending the reply",
      body: `see ${USER_WORDS_BLOCK_START}`, draft: { to: "client@example.com", text: `Hello ${USER_WORDS_BLOCK_START}` },
    });
    expect(r.ok).toBe(true);
    const card = made[0]!;
    expect(card.title).toBe("sending the reply");
    expect(card.body).not.toContain(USER_WORDS_BLOCK_START);
    expect(card.payload!.draft!.text).not.toContain(USER_WORDS_BLOCK_START);
    expect(card.payload!.draft!.sha256).toBe(draftSha256(card.payload!.draft!.to, card.payload!.draft!.text));
    expect(card.wake).toBe(false);
  });
});

describe("no hourly cap", () => {
  it("files every one of 25 different decisions in a row as its own card", () => {
    const h = fakeEnv();
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const r = fileReport(h.env, caller, { kind: "needs_decision", title: `Merge PR #${i}?`, body: "Tests pass." });
      expect(r.ok).toBe(true);
      if (r.ok) ids.add(r.cardId!);
    }
    expect(h.made).toHaveLength(25);
    expect(ids.size).toBe(25);
  });

  it("never answers with the old hourly limit, whatever the kind", () => {
    const h = fakeEnv();
    for (const kind of ["needs_decision", "urgent", "done", "failed"] as const) {
      for (let i = 0; i < 25; i++) {
        const r = fileReport(h.env, caller, { kind, title: `${kind} ${i}` });
        expect(r.ok).toBe(true);
        expect(JSON.stringify(r)).not.toContain("in the last hour");
      }
    }
    expect(h.made).toHaveLength(100);
  });
});

describe("the same report twice", () => {
  const decision = {
    kind: "needs_decision", title: "Deploy to staging?", body: "Build is green.",
    options: [{ id: "deploy", label: "Deploy now" }, { id: "wait", label: "Wait" }],
  };

  it("hands back the open card instead of filing a second one", () => {
    const h = fakeEnv();
    const first = fileReport(h.env, caller, decision);
    const again = fileReport(h.env, caller, decision);
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.cardId).toBe(first.cardId);
    expect(again.kind).toBe("needs_decision");
    expect(again.note).toBe(SAME_REPORT_NOTE);
    expect(h.made).toHaveLength(1);
  });

  it("files it again once the earlier card is closed", () => {
    const h = fakeEnv();
    const first = fileReport(h.env, caller, decision);
    if (!first.ok) throw new Error("first report refused");
    h.close(first.cardId!);
    const again = fileReport(h.env, caller, decision);
    expect(again.ok && again.cardId).toBe("card-2");
    expect(h.made).toHaveLength(2);
  });

  it("files a report that differs in kind, body, options or draft", () => {
    const h = fakeEnv();
    fileReport(h.env, caller, decision);
    fileReport(h.env, caller, { ...decision, body: "Build is green. Two reviews in." });
    fileReport(h.env, caller, { ...decision, options: [{ id: "deploy", label: "Deploy now" }, { id: "drop", label: "Drop it" }] });
    fileReport(h.env, caller, { kind: "urgent", title: decision.title, body: decision.body, options: decision.options });
    fileReport(h.env, caller, { kind: "needs_decision", title: "Reply to the client?", draft: { to: "client", text: "Done." } });
    fileReport(h.env, caller, { kind: "needs_decision", title: "Reply to the client?", draft: { to: "client", text: "Done today." } });
    expect(h.made).toHaveLength(6);
  });

  it("does not merge another manager's identical report", () => {
    const h = fakeEnv();
    fileReport(h.env, caller, decision);
    fileReport(h.env, { ...caller, sessionId: "mgr-2" }, decision);
    expect(h.made).toHaveLength(2);
  });
});

describe("caps", () => {
  it("turns urgent into a decision past the per-window cap, and collapses an identical title", () => {
    const h = fakeEnv({ quietStart: 900_000 });
    const kinds: AssistantCardKind[] = [];
    for (let i = 0; i < URGENT_PER_MANAGER_PER_QUIET_WINDOW + 1; i++) {
      const r = fileReport(h.env, caller, { kind: "urgent", title: `server ${i} down` });
      if (r.ok) kinds.push(r.kind);
    }
    expect(kinds).toEqual([...Array(URGENT_PER_MANAGER_PER_QUIET_WINDOW).fill("urgent"), "needs_decision"]);
    expect(h.made.at(-1)!.payload?.urgentCapped).toBe(true);
    expect(h.made.at(-1)!.wake).toBe(false);
    const again = fileReport(h.env, caller, { kind: "urgent", title: "server 0 down" });
    expect(again.ok && again.cardId).toBe("card-1");
    expect(h.made).toHaveLength(URGENT_PER_MANAGER_PER_QUIET_WINDOW + 1);
  });

  it("does not cap urgent outside quiet hours", () => {
    const h = fakeEnv({ quietStart: null });
    for (let i = 0; i < 4; i++) {
      const r = fileReport(h.env, caller, { kind: "urgent", title: `x${i}` });
      expect(r.ok && r.kind).toBe("urgent");
    }
  });
  it("puts this project's design screenshots on the card, and refuses any other id", () => {
    const w = fakeEnv();
    const ok = fileReport(w.env, caller, { kind: "needs_decision", title: "Pick a variant", body: "1 or 2?", images: [SHOT, SHOT] });
    expect(ok.ok).toBe(true);
    expect(w.made[0]!.payload.images).toEqual([{ id: SHOT, designTitle: "Kho task", file: "variant-2.html", label: "Dark" }]);
    const foreign = fileReport(w.env, caller, { kind: "needs_decision", title: "x", images: [FOREIGN] });
    expect(foreign).toMatchObject({ ok: false });
    expect(fileReport(w.env, caller, { kind: "done", title: "x", images: [] })).toMatchObject({ ok: false });
    expect(fileReport(w.env, caller, { kind: "done", title: "x", images: Array(7).fill(SHOT) })).toMatchObject({ ok: false });
    expect(fileReport(w.env, caller, { kind: "digest", title: "x", images: [SHOT] })).toMatchObject({ ok: false });
    expect(w.made).toHaveLength(1);
  });
});
