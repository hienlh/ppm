/**
 * The Telegram card for settings the Assistant changed from a Telegram turn: posted when the turn
 * ends, one Undo per setting (the user's own press, no card), never a value of a secret, and a
 * download's progress drawn as one message.
 */
import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { AssistantTelegramSettingsChanges, progressHtml } from "../../../../src/services/assistant-telegram/assistant-telegram-settings-changes.ts";
import { ButtonCodes } from "../../../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import type { AssistantTelegramSendQueue } from "../../../../src/services/assistant-telegram/assistant-telegram-send-queue.ts";
import type { BridgeAction, SettingsPress } from "../../../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import { recordSettingChange } from "../../../../src/services/assistant-settings-tools/settings-change-log.ts";

interface Sent { chatId: string; html: string; markup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> } }

function harness(undo: (id: number) => Promise<{ ok: true } | { ok: false; error: string }>) {
  const sent: Sent[] = [];
  const edits: string[] = [];
  const client = {
    sendMessage: async (chatId: string, html: string, o: { replyMarkup?: Sent["markup"] }) => {
      sent.push({ chatId, html, ...(o.replyMarkup ? { markup: o.replyMarkup } : {}) });
      return { ok: true, result: { message_id: sent.length } };
    },
    editMessageText: async (_c: string, _m: number, html: string) => { edits.push(html); return { ok: true, result: {} }; },
  };
  const queue = {
    enqueue: (_chatId: string, task: { run: (c: unknown) => Promise<unknown> }) => { void task.run(client); },
    noteSent: () => {},
  } as unknown as AssistantTelegramSendQueue;
  const codes = new ButtonCodes<BridgeAction>();
  const cards = new AssistantTelegramSettingsChanges({ queue, codes, chatsOf: () => ["42"], undo, link: async () => "https://ppm.example.com/?openSettings=assistant:changes" });
  cards.attach();
  return { cards, codes, sent, edits };
}

const change = (over: Partial<Parameters<typeof recordSettingChange>[0]> = {}) => recordSettingChange({
  sessionId: "assistant-tg", origin: "telegram", approval: "full", kind: "setting", key: "notifications.events.done",
  label: "Notifications → Chat finished", before: true, after: false, beforeText: "On", afterText: "Off", ...over,
});

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("the settings card on Telegram", () => {
  it("is posted when the turn ends, with Undo and Open in PPM, and Undo acts as the user", async () => {
    const undone: number[] = [];
    const h = harness(async (id) => { undone.push(id); return { ok: true }; });
    const row = change();
    change({ origin: "ppm" }); // a change typed in PPM gets no Telegram card
    await h.cards.flush("assistant-tg");
    await tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.html).toContain("Changed 1 setting");
    expect(h.sent[0]!.html).toContain("Notifications → Chat finished:</b> On → Off");
    const buttons = h.sent[0]!.markup!.inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(["↩️ Undo", "Open in PPM"]);

    const taken = h.codes.take(buttons[0]!.callback_data, "42");
    expect(taken.ok).toBe(true);
    const press = (taken as { action: SettingsPress; group: string }).action;
    expect(await h.cards.press("42", press, (taken as { group: string }).group)).toBe("Undone");
    expect(undone).toEqual([row.id]);
    await tick();
    expect(h.edits.at(-1)).toContain("Undone");
    h.cards.detach();
  });

  it("shows why an Undo did not happen", async () => {
    const h = harness(async () => ({ ok: false, error: "It was changed again since (now Off)" }));
    change();
    await h.cards.flush("assistant-tg");
    await tick();
    const taken = h.codes.take(h.sent[0]!.markup!.inline_keyboard[0]![0]!.callback_data, "42") as { action: SettingsPress; group: string };
    expect(await h.cards.press("42", taken.action, taken.group)).toBe("Not undone");
    await tick();
    expect(h.edits.at(-1)).toContain("changed again since");
    h.cards.detach();
  });

  it("shows a long text value as its start and length, under Telegram's limit", async () => {
    const h = harness(async () => ({ ok: true }));
    const long = "x".repeat(9000);
    change({ key: "assistant.instructions", label: "PPM Assistant → Instructions", before: "", after: long, beforeText: "(empty)", afterText: long });
    await h.cards.flush("assistant-tg");
    await tick();
    expect(h.sent[0]!.html.length).toBeLessThan(4096);
    expect(h.sent[0]!.html).toContain("(9000 characters)");
    h.cards.detach();
  });

  it("draws a download as a percentage, then its end", () => {
    expect(progressHtml({ label: "Whisper", receivedBytes: 287_000_000, totalBytes: 574_000_000, done: false, error: null })).toContain("50% (287 MB of 574 MB)");
    expect(progressHtml({ label: "Whisper", receivedBytes: 0, totalBytes: 0, done: true, error: null })).toContain("is installed");
    expect(progressHtml({ label: "Whisper", receivedBytes: 0, totalBytes: 0, done: true, error: "disk full" })).toContain("disk full");
  });
});
