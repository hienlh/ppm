/**
 * Settings the PPM Assistant changed from a Telegram turn come back to that chat as one card when
 * the turn ends: each setting, before → after, how it was allowed, an Undo per change and Open in
 * PPM (Settings → PPM Assistant → Changes). Undo is the user's own press: no card, the same
 * compare-and-set as the Changes tab, so a value changed since is left alone and the card says why.
 *
 * A background install started from Telegram (Whisper, the relay) gets one message edited in place
 * as it downloads, rather than one per step. Nothing here ever carries a secret: the settings tools
 * refuse them, so neither a value nor a token reaches these cards.
 */
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { resolveMigratedSession } from "../db.service.ts";
import { telegramChatsBoundTo } from "../assistant-hub/assistant-hub-db.ts";
import { escapeTelegramHtml } from "../notification-format.ts";
import { notificationLink } from "../notification-link.ts";
import { createLogger } from "../logger.ts";
import type { InlineKeyboardButton } from "../telegram/telegram-types.ts";
import type { SettingChangeRow } from "../../shared/assistant-settings-changes.ts";
import { settingsChangeEvents } from "../assistant-settings-tools/settings-change-log.ts";
import { installProgressEvents, type InstallProgress } from "../assistant-settings-tools/settings-install-watch.ts";
import { canSendTo } from "./assistant-telegram-access.ts";
import type { BridgeAction, SettingsPress } from "./assistant-telegram-actions.ts";
import type { ButtonCodes } from "./assistant-telegram-button-codes.ts";
import { placeLink } from "./assistant-telegram-links.ts";
import { sendMessageTask, type AssistantTelegramSendQueue } from "./assistant-telegram-send-queue.ts";
import { buttonText, editCard } from "./assistant-telegram-task-common.ts";

const log = createLogger("assistant-telegram");
const MAX_CARDS = 100;
/** One card lists at most this many changes; the rest are in Settings. */
export const CHANGES_PER_CARD = 8;
/** A progress message is edited at most this often. */
const EDIT_EVERY_MS = 5_000;

export interface SettingsChangesDeps {
  queue: AssistantTelegramSendQueue;
  codes: ButtonCodes<BridgeAction>;
  /** Which chats see this Assistant session; by default the ones bound to it that PPM may write to. */
  chatsOf?: (sessionId: string) => string[];
  /** The user's own Undo; resolves to the toast. */
  undo?: (changeId: number) => Promise<{ ok: true } | { ok: false; error: string }>;
  link?: () => Promise<string>;
}

interface Card { id: string; chatId: string; messageId: number | null; rows: SettingChangeRow[]; undone: Map<number, string>; link: { button?: InlineKeyboardButton; inline?: string }; seq: number }

const liveUndo = async (changeId: number) => {
  const [{ routeCallerFor }, { undoSettingChange }] = await Promise.all([
    import("../assistant-mcp/assistant-tool-family.ts"), import("../assistant-settings-tools/settings-apply.ts"),
  ]);
  const out = await undoSettingChange(changeId, { callRoute: routeCallerFor("settings"), approval: "user", origin: "telegram", sessionId: null });
  return out.ok ? { ok: true as const } : { ok: false as const, error: out.error };
};
const liveLink = () => notificationLink({ project: "", sessionId: "", path: "/?openSettings=assistant:changes" });

const esc = escapeTelegramHtml;
/** A value longer than this (instructions, a persona) is shown as its start and its length. */
const VALUE_MAX = 120;
/** Telegram refuses a message over 4096 characters; the card stays well under it. */
const CARD_MAX = 3500;
const shortValue = (v: string | null): string => {
  const text = (v ?? "").replace(/\s+/g, " ").trim();
  return text.length <= VALUE_MAX ? text : `${text.slice(0, VALUE_MAX)}… (${text.length} characters)`;
};
const howOf = (r: SettingChangeRow) => (r.approval === "full" ? "Full mode, no card" : "allowed on a card");

export class AssistantTelegramSettingsChanges {
  private readonly cards = new Map<string, Card>();
  private readonly pending = new Map<string, SettingChangeRow[]>();
  private readonly progress = new Map<string, { chatId: string; messageId: number | null; lastEdit: number }[]>();
  private offs: Array<() => void> = [];

  constructor(private readonly deps: SettingsChangesDeps) {}

  attach(): void {
    if (this.offs.length) return;
    this.offs = [
      settingsChangeEvents.on((row) => this.onChange(row)),
      installProgressEvents.on((p) => this.onProgress(p)),
      chatLifecycle.on("turn_ended", (e) => { if (!e.turnStillRunning) void this.flush(e.sessionId); }),
    ];
  }

  detach(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.pending.clear();
    this.cards.clear();
    this.progress.clear();
  }

  forgetChat(chatId: string): void {
    for (const [id, card] of this.cards) if (card.chatId === chatId) { this.deps.codes.dropGroup(groupOf(card)); this.cards.delete(id); }
  }

  private chatsOf(sessionId: string): string[] {
    try {
      return this.deps.chatsOf ? this.deps.chatsOf(sessionId) : telegramChatsBoundTo(sessionId).filter(canSendTo);
    } catch (e) {
      log.warn(`settings cards: could not tell which chats see ${sessionId}: ${(e as Error).message}`);
      return [];
    }
  }

  private onChange(row: SettingChangeRow): void {
    if (row.origin !== "telegram" || !row.sessionId || row.approval === "user") return;
    const key = resolveMigratedSession(row.sessionId);
    this.pending.set(key, [...(this.pending.get(key) ?? []), row]);
  }

  /** Posts the turn's changes to the chats that see the session. */
  async flush(sessionId: string): Promise<void> {
    const key = resolveMigratedSession(sessionId);
    const rows = this.pending.get(key) ?? [];
    this.pending.delete(key);
    if (!rows.length) return;
    const chats = this.chatsOf(key);
    if (!chats.length) return;
    const url = await (this.deps.link ?? liveLink)().catch(() => "");
    const link = url ? placeLink(url, "Open in PPM") : {};
    for (const chatId of chats) this.post({ id: crypto.randomUUID().slice(0, 12), chatId, messageId: null, rows: rows.slice(0, CHANGES_PER_CARD), undone: new Map(), link, seq: 0 });
  }

  private post(card: Card): void {
    while (this.cards.size >= MAX_CARDS) {
      const [id, old] = this.cards.entries().next().value!;
      this.deps.codes.dropGroup(groupOf(old));
      this.cards.delete(id);
    }
    this.cards.set(card.id, card);
    const { html, rows } = this.draw(card);
    this.deps.queue.enqueue(card.chatId, sendMessageTask(this.deps.queue, card.chatId, { html, ...(rows.length ? { markup: { inline_keyboard: rows } } : {}) }, {
      label: "settings card",
      onSent: (sent) => { card.messageId = sent.message_id; },
      onDropped: () => { this.deps.codes.dropGroup(groupOf(card)); this.cards.delete(card.id); },
    }));
  }

  private draw(card: Card): { html: string; rows: InlineKeyboardButton[][] } {
    this.deps.codes.dropGroup(groupOf(card));
    card.seq++;
    const group = groupOf(card);
    const n = card.rows.length;
    const lines = [`⚙️ <b>${n === 1 ? "Changed 1 setting" : `Changed ${n} settings`}</b>`];
    const buttons: InlineKeyboardButton[][] = [];
    for (const r of card.rows) {
      const change = r.kind === "setting" ? `${esc(shortValue(r.beforeText))} → ${esc(shortValue(r.afterText))}` : esc(shortValue(r.afterText));
      const after = card.undone.get(r.id);
      lines.push(`<b>${esc(r.label)}:</b> ${change} <i>(${howOf(r)})</i>${after ? `\n   ↩️ ${esc(after)}` : ""}`);
      if (r.kind === "setting" && !card.undone.has(r.id)) {
        const press: SettingsPress = { kind: "settings", ref: card.id, op: "undo", changeId: r.id };
        buttons.push([{ text: buttonText(n === 1 ? "↩️ Undo" : `↩️ Undo ${r.label.split(" → ").pop() ?? r.label}`), callback_data: this.deps.codes.mint(card.chatId, group, press) }]);
      }
    }
    let dropped = 0;
    while (lines.join("\n").length > CARD_MAX && lines.length > 2) { lines.pop(); dropped++; }
    if (dropped) lines.push("…and more in Settings → PPM Assistant → Changes.");
    if (card.link.inline) lines.push("", card.link.inline);
    if (card.link.button) buttons.push([card.link.button]);
    return { html: lines.join("\n"), rows: buttons };
  }

  owns(ref: string): boolean {
    return this.cards.has(ref);
  }

  /** Acts on an Undo; the toast to show. */
  async press(chatId: string, press: SettingsPress, group: string): Promise<string> {
    const card = this.cards.get(press.ref);
    if (!card || card.chatId !== chatId) { this.deps.codes.dropGroup(group); return "This card is no longer open — see Settings → PPM Assistant → Changes."; }
    if (group !== groupOf(card)) return "This button is no longer valid.";
    const out = await (this.deps.undo ?? liveUndo)(press.changeId).catch((e: Error) => ({ ok: false as const, error: e.message }));
    card.undone.set(press.changeId, out.ok ? "Undone" : `Not undone: ${out.error}`);
    if (card.messageId !== null) { const { html, rows } = this.draw(card); editCard(this.deps.queue, card.chatId, card.messageId, html, rows); }
    return out.ok ? "Undone" : "Not undone";
  }

  private onProgress(p: InstallProgress): void {
    if (p.origin !== "telegram" || !p.sessionId) return;
    let targets = this.progress.get(p.id);
    if (!targets) {
      targets = this.chatsOf(resolveMigratedSession(p.sessionId)).map((chatId) => ({ chatId, messageId: null, lastEdit: 0 }));
      this.progress.set(p.id, targets);
      for (const t of targets) {
        this.deps.queue.enqueue(t.chatId, sendMessageTask(this.deps.queue, t.chatId, { html: progressHtml(p) }, {
          label: "install progress", onSent: (sent) => { t.messageId = sent.message_id; t.lastEdit = Date.now(); },
        }));
      }
      if (p.done) this.progress.delete(p.id);
      return;
    }
    for (const t of targets) {
      if (t.messageId === null || (!p.done && Date.now() - t.lastEdit < EDIT_EVERY_MS)) continue;
      t.lastEdit = Date.now();
      editCard(this.deps.queue, t.chatId, t.messageId, progressHtml(p), []);
    }
    if (p.done) this.progress.delete(p.id);
  }
}

export function progressHtml(p: Pick<InstallProgress, "label" | "receivedBytes" | "totalBytes" | "done" | "error">): string {
  if (p.done) return p.error ? `⚠️ <b>${esc(p.label)}</b> was not installed: ${esc(p.error)}` : `✅ <b>${esc(p.label)}</b> is installed.`;
  const pct = p.totalBytes ? Math.floor((p.receivedBytes / p.totalBytes) * 100) : 0;
  const mb = (b: number) => `${Math.round(b / 1_000_000)} MB`;
  return `⬇️ Installing <b>${esc(p.label)}</b>: ${pct}%${p.totalBytes ? ` (${mb(p.receivedBytes)} of ${mb(p.totalBytes)})` : ""}`;
}

const groupOf = (card: Card): string => `settings:${card.id}:${card.seq}`;
