/**
 * A card offering choices on Telegram: the choices listed in the text and one button each (in
 * place of OK), one per row; no button where the card is not shown whole or only its title goes
 * to the phone; each button a short random code that keeps the choice's id on the server; and a
 * press reaching the same choose action PPM's own button does.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { CHOICES_IN_PPM_NOTE, DESCRIPTIONS_CUT_NOTE, formatManagerCard } from "../../../../src/services/assistant-telegram/assistant-telegram-card-kinds.ts";
import { AssistantTelegramManagerCards } from "../../../../src/services/assistant-telegram/assistant-telegram-manager-cards.ts";
import { AssistantTelegramCardReplies } from "../../../../src/services/assistant-telegram/assistant-telegram-card-replies.ts";
import { ButtonCodes } from "../../../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import type { BridgeAction } from "../../../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import { cardOkOffered } from "../../../../src/services/assistant-cards/card-ok-rule.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import { parseTelegramHtml } from "../../../helpers/fake-telegram-bot-api.ts";
import type { AssistantCard, CardOption } from "../../../../src/shared/assistant-cards.ts";
import { clientFor, connectChat, freshChat, queueFor, useFakeTelegram } from "./bridge-test-kit.ts";

const fake = useFakeTelegram();
const client = clientFor(fake);
beforeEach(() => { getDb().query("DELETE FROM clawbot_paired_chats").run(); });

const OPTIONS: CardOption[] = [
  { id: "merge-now", label: "Merge now", description: "Merge PR #4120 and deploy to staging." },
  { id: "wait-review", label: "Wait for review", description: "Leave it for the second reviewer." },
  { id: "drop", label: "Drop the change" },
];

function card(over: Partial<AssistantCard> = {}): AssistantCard {
  const base: AssistantCard = {
    id: crypto.randomUUID(), kind: "needs_decision", projectName: "nxsys", projectKey: "k", sessionId: "mgr",
    title: "NX-6318: how to ship the fix", body: "Staging is **green**.", status: "open", answer: null,
    provenance: "Written by the nxsys manager AI", createdAt: 1, updatedAt: 1, payload: { options: OPTIONS },
    ...over,
  };
  return cardOkOffered(base) ? { ...base, okOffered: true } : base;
}
const visible = (html: string) => {
  const parsed = parseTelegramHtml(html);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.text;
};

describe("a card with choices, as Telegram gets it", () => {
  it("lists the choices and offers one numbered button each, and no OK", () => {
    const f = formatManagerCard(card(), "full");
    expect(f.buttons).toEqual([
      { text: "1. Merge now", op: "choose", optionId: "merge-now" },
      { text: "2. Wait for review", op: "choose", optionId: "wait-review" },
      { text: "3. Drop the change", op: "choose", optionId: "drop" },
    ]);
    const text = visible(f.html);
    // Right under the body, one line each: the button's own text, then what it does.
    expect(text).toContain("Staging is green.\n\n1. Merge now: Merge PR #4120 and deploy to staging.\n2. Wait for review: Leave it for the second reviewer.\n3. Drop the change\n");
    expect(text).not.toContain("Choices");
    expect(f.html).toContain("<b>1. Merge now</b>: Merge PR #4120");
    expect(text).toContain("Reply to this message to answer in your own words.");
  });

  it("escapes a choice's label and description before formatting them", () => {
    const f = formatManagerCard(card({ payload: { options: [
      { id: "a", label: "Ship <b>now</b> & tag", description: "Runs `deploy <prod>` & tags it." },
      { id: "b", label: "Wait" },
    ] } }), "full");
    expect(f.html).toContain("<b>1. Ship &lt;b&gt;now&lt;/b&gt; &amp; tag</b>: Runs `deploy &lt;prod&gt;` &amp; tags it.");
    expect(visible(f.html)).toContain("1. Ship <b>now</b> & tag: Runs `deploy <prod>` & tags it.");
  });

  it("cuts the descriptions of a card too long for one message, and keeps every label and button", () => {
    const long = (n: number) => `${"Description words that explain what this choice does. ".repeat(6)}#${n}`.slice(0, 300);
    const labels = Array.from({ length: 6 }, (_, i) => `Choice ${i + 1}: ${"a long label ".repeat(5)}`.slice(0, 80).trim());
    const c = card({
      body: "Plan paragraph that goes on for a while. ".repeat(60),
      payload: { options: labels.map((label, i) => ({ id: `o${i}`, label, description: long(i) })) },
    });
    expect(c.okOffered).toBe(true);
    const f = formatManagerCard(c, "full");
    expect(f.buttons.map((b) => b.optionId)).toEqual(["o0", "o1", "o2", "o3", "o4", "o5"]);
    const text = visible(f.html);
    expect(text.length).toBeLessThanOrEqual(4096);
    for (const [i, label] of labels.entries()) expect(text).toContain(`${i + 1}. ${label}`);
    expect(text).toContain(DESCRIPTIONS_CUT_NOTE);
    expect(text).not.toContain(CHOICES_IN_PPM_NOTE);
    expect(text).not.toContain(long(0));
  });

  it("offers no button when the card is not shown whole, and says how to answer", () => {
    const hidden = card({ payload: { options: [{ id: "a", label: "Use key", description: "AKIAABCDEFGHIJKLMNOP" }, { id: "b", label: "Wait" }] } });
    expect(hidden.okOffered).toBeUndefined();
    const f = formatManagerCard(hidden, "full");
    expect(f.buttons).toEqual([]);
    expect(visible(f.html)).toContain(CHOICES_IN_PPM_NOTE);
  });

  it("shows neither the choices nor their buttons where only the title goes to the phone", () => {
    const f = formatManagerCard(card(), "title");
    expect(f.buttons).toEqual([]);
    expect(visible(f.html)).not.toContain("Merge now");
  });
});

describe("sending and pressing", () => {
  it("puts each choice on its own row behind a short code that keeps the id on the server", async () => {
    const chat = connectChat(freshChat());
    const codes = new ButtonCodes<BridgeAction>();
    const c = card();
    const queue = queueFor(client);
    new AssistantTelegramManagerCards({
      queue, codes,
      chatLink: async () => "http://localhost:8080/x", sessionLink: async () => "http://localhost:8080/assistant",
      relayCard: () => {}, isShowing: () => false, recipients: () => [chat], detailOf: () => "full", isOpen: () => true,
    }).send([c]);
    await fake.waitFor(() => fake.sent(Number(chat)).length === 1);
    await queue.whenIdle();
    const [m] = fake.sent(Number(chat));
    const rows = m!.reply_markup!.inline_keyboard;
    expect(rows.slice(0, 3).map((r) => r.map((b) => b.text))).toEqual([["1. Merge now"], ["2. Wait for review"], ["3. Drop the change"]]);
    for (const [i, row] of rows.slice(0, 3).entries()) {
      const data = row[0]!.callback_data!;
      expect(data).toMatch(/^a:[A-Za-z0-9_-]{16}$/);
      expect(data).not.toContain(OPTIONS[i]!.id);
      expect(codes.peek(data, chat)).toMatchObject({ ok: true, action: { kind: "mcard", cardId: c.id, op: "choose", optionId: OPTIONS[i]!.id } });
      expect(codes.peek(data, "another-chat").ok).toBe(false);
    }
  });

  it("sends a press to the choose action with the button's choice, and spends the card's buttons", async () => {
    const codes = new ButtonCodes<BridgeAction>();
    const calls: Array<{ id: string; body: unknown }> = [];
    const replies = new AssistantTelegramCardReplies({
      codes, reply: () => {},
      choose: async (id, body) => {
        calls.push({ id, body });
        return { ok: true, card: card(), to: "manager", projectName: "nxsys" };
      },
    });
    const group = "mcard:c1:42";
    const data = codes.mint("42", group, { kind: "mcard", cardId: "c1", op: "choose", optionId: "drop" });
    codes.mint("42", group, { kind: "mcard", cardId: "c1", op: "choose", optionId: "merge-now" });
    const press = codes.peek(data, "42");
    if (!press.ok || press.action.kind !== "mcard") throw new Error("no press");
    expect(await replies.press("42", press.action, press.group)).toBe("Sent to the nxsys manager.");
    expect(calls).toEqual([{ id: "c1", body: { optionId: "drop" } }]);
    expect(codes.size).toBe(0);
  });

  it("leaves the codes to the card when the forward failed (the reopened card is sent again)", async () => {
    const codes = new ButtonCodes<BridgeAction>();
    const replies = new AssistantTelegramCardReplies({
      codes, reply: () => {},
      choose: async () => ({ ok: false, status: 502, error: "Not sent: chat gone" }),
    });
    const data = codes.mint("42", "g", { kind: "mcard", cardId: "c1", op: "choose", optionId: "drop" });
    const press = codes.peek(data, "42");
    if (!press.ok || press.action.kind !== "mcard") throw new Error("no press");
    expect(await replies.press("42", press.action, press.group)).toBe("Not sent: chat gone");
    expect(codes.size).toBe(1);
  });
});
