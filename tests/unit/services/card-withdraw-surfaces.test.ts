/**
 * What a withdrawn card says everywhere it is shown, and what the withdrawal switch turns on:
 * the Telegram end line and its HTML, a late reply asked about rather than refused, the PPM
 * questions for a late reply or press, the digest ask, the manager's rule, and the Assistant's
 * `card_withdraw` (off, and in a turn PPM started).
 */
import { describe, expect, it } from "bun:test";
import { cardEndLine } from "../../../src/services/assistant-telegram/assistant-telegram-card-kinds.ts";
import { cardDecided } from "../../../src/services/assistant-telegram/assistant-telegram-card-replies.ts";
import { alreadyAnsweredText, staleQuestion } from "../../../src/services/assistant-cards/card-reply-actions.ts";
import { DIGEST_ASK_TEXT, DIGEST_ASK_WITHDRAW_TEXT, digestAskText } from "../../../src/services/assistant-digest/assistant-digest-env.ts";
import { managerContextEntry, MANAGER_WITHDRAW_RULE } from "../../../src/services/assistant-managers/manager-context-entry.ts";
import { CARD_WITHDRAW_OFF, cardWithdrawTool } from "../../../src/services/assistant-mcp/assistant-card-withdraw-tool.ts";
import { parseTelegramHtml } from "../../helpers/fake-telegram-bot-api.ts";
import { cardWithdrawal, type AssistantCard } from "../../../src/shared/assistant-cards.ts";
import { ppmToolOn } from "../../../src/shared/ppm-tools.ts";
import { featureIntroOfTool } from "../../../src/shared/feature-intros.ts";
import type { CardRow } from "../../../src/services/assistant-cards/assistant-cards-db.ts";

const AT = Date.UTC(2026, 10, 25, 10, 40);

function card(over: Partial<AssistantCard> = {}): AssistantCard {
  return {
    id: "50c42428-0000-4000-8000-000000000001", kind: "needs_decision", projectName: "nxsys", projectKey: "k", sessionId: "mgr",
    title: "Pay the deposit?", body: "", status: "open", answer: null, payload: {}, provenance: null, createdAt: AT - 3_600_000, updatedAt: AT,
    ...over,
  };
}
const replaced = card({
  status: "dismissed",
  answer: { by: "manager", channel: "chat", at: AT, note: "Replaced", withdrawn: { sessionId: "mgr", reason: "Asked again", supersededBy: { id: "f2", title: "Pay the deposit <today>?" } } },
});
const withdrawn = card({
  status: "dismissed",
  answer: { by: "manager", channel: "chat", at: AT, note: "Withdrawn", withdrawn: { sessionId: "mgr", reason: "You paid it yourself" } },
});
const visible = (html: string) => {
  const parsed = parseTelegramHtml(html);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.text;
};

describe("a withdrawn card on Telegram", () => {
  it("names the card that replaced it, escaped", () => {
    expect(visible(cardEndLine(replaced))).toBe("↪️ Replaced by: Pay the deposit <today>?");
  });

  it("says who withdrew it and why", () => {
    expect(visible(cardEndLine(withdrawn))).toBe("Withdrawn by the manager: You paid it yourself");
    expect(visible(cardEndLine({ ...withdrawn, answer: { ...withdrawn.answer!, by: "assistant" } }))).toContain("by the Assistant");
  });

  it("keeps the user's own dismissal as it was, and says PPM's reason for one PPM cleared", () => {
    const mine = card({ status: "dismissed", answer: { by: "user", channel: "ppm", at: AT } });
    expect(visible(cardEndLine(mine))).toBe("Dismissed.");
    const cleared = card({ kind: "done", status: "dismissed", answer: { by: "ppm", channel: "ppm", at: AT, note: "Task nxsys/7 was closed" } });
    expect(visible(cardEndLine(cleared))).toBe("Task nxsys/7 was closed.");
  });

  it("is not decided by the user, so a reply to it is asked about instead of refused", () => {
    expect(cardDecided(replaced)).toBe(false);
    expect(cardDecided(card({ status: "dismissed", answer: { by: "user", channel: "ppm", at: AT } }))).toBe(true);
  });
});

describe("a late reply or press on a withdrawn card in PPM", () => {
  it("asks before sending, naming what replaced it or why it went", () => {
    expect(staleQuestion(replaced, AT + 60_000, "UTC")).toBe('This card was replaced by "Pay the deposit <today>?" at 10:40 — send to its manager anyway?');
    expect(staleQuestion(withdrawn, AT + 60_000, "UTC")).toBe("The manager withdrew this card at 10:40 (You paid it yourself) — send anyway?");
  });

  it("tells a late OK where to answer instead", () => {
    expect(alreadyAnsweredText(replaced, AT, "UTC")).toBe('This card was replaced by "Pay the deposit <today>?"; answer that one.');
    expect(alreadyAnsweredText(withdrawn, AT, "UTC")).toBe("This card was withdrawn at 10:40: You paid it yourself");
  });
});

describe("the switch", () => {
  it("is a feature introduction: off until the user chooses", () => {
    expect(featureIntroOfTool("report_withdraw")?.id).toBe("card-withdraw-2026-11");
    expect(ppmToolOn({}, "report_withdraw")).toBe(false);
    expect(ppmToolOn({ ppm_tools: { report_withdraw: true } }, "report_withdraw")).toBe(true);
  });

  it("adds the reminder to the digest ask only while on, as fixed text", () => {
    expect(digestAskText(false)).toBe(DIGEST_ASK_TEXT);
    expect(digestAskText(true)).toBe(`${DIGEST_ASK_TEXT} ${DIGEST_ASK_WITHDRAW_TEXT}`);
  });

  it("puts the rule in the manager's block only while on", () => {
    expect(managerContextEntry("api", "", "")).not.toContain("report_withdraw");
    expect(managerContextEntry("api", "", "", { withdraw: true })).toContain(MANAGER_WITHDRAW_RULE);
  });
});

describe("the Assistant's card_withdraw", () => {
  const row = (over: Partial<CardRow> = {}): CardRow => ({
    id: "50c42428-0000-4000-8000-000000000001", kind: "needs_decision", projectKey: "k", sessionId: "mgr", title: "Old", body: "",
    payload: {}, status: "open", answer: null, outbound: "sent", wake: "none", telegramRefs: [], createdAt: 1, updatedAt: 1, ...over,
  });
  const moves: string[] = [];
  const deps = (on: boolean, userTurn: boolean, r = row()) => ({
    on: () => on,
    userStartedTurn: async () => userTurn,
    env: {
      cards: {
        transition: (id: string) => { moves.push(id); return { ok: true as const, card: card() }; },
        toCard: () => card(),
      },
      now: () => AT, row: () => r, openWithPrefix: () => [r], turnOf: () => "t1", withdrawnCount: () => 0,
    },
  });
  const text = (out: unknown) => (out as { content: Array<{ text: string }> }).content[0]!.text;

  it("is refused while the switch is off", async () => {
    const out = await cardWithdrawTool("asst", { cards: ["50c42428"], reason: "x" }, deps(false, true));
    expect(text(out)).toContain(CARD_WITHDRAW_OFF);
  });

  it("takes a manager's card in a turn the user started, not in one PPM started", async () => {
    moves.length = 0;
    const started = JSON.parse(text(await cardWithdrawTool("asst", { cards: ["50c42428"], reason: "You asked" }, deps(true, true))));
    expect(started.withdrawn[0].outcome).toBe("withdrawn");
    const unattended = JSON.parse(text(await cardWithdrawTool("asst", { cards: ["50c42428"], reason: "stale" }, deps(true, false))));
    expect(unattended.withdrawn[0].outcome).toBe("not_yours");
    expect(moves).toHaveLength(1);
  });
});

describe("cardWithdrawal", () => {
  it("is set only on a dismissed card its author withdrew", () => {
    expect(cardWithdrawal(replaced)?.supersededBy?.id).toBe("f2");
    expect(cardWithdrawal({ ...replaced, status: "open" })).toBeNull();
    expect(cardWithdrawal(card({ status: "dismissed", answer: { by: "user", channel: "ppm", at: AT } }))).toBeNull();
  });
});
