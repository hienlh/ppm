/**
 * What an inline button stands for. A button carries only a random code (Telegram gives a button
 * 64 bytes of data and shows it to nobody, but anything in it comes back exactly as sent, so it is
 * never trusted to carry a request id or a decision); the meaning stays here, in memory.
 *
 * A code works only in the chat it was made for, expires after a day, and is spent with the
 * other codes of its group: pressing Allow takes Deny away too, so a second press — or a press on
 * a copy of the card — answers "no longer valid". After a restart every code is gone, which is
 * also "no longer valid": nothing pressed on a card from before can run.
 */
import { randomBytes } from "node:crypto";

export const CODE_PREFIX = "a:";
export const MAX_CODES = 500;
export const CODE_TTL_MS = 24 * 60 * 60_000;

interface Held<T> { chatId: string; group: string; action: T; expiresAt: number }

export type TakeResult<T> = { ok: true; action: T; group: string } | { ok: false };

export class ButtonCodes<T> {
  private readonly codes = new Map<string, Held<T>>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** A fresh code for `action`, as the button's `callback_data`. */
  mint(chatId: string, group: string, action: T): string {
    this.prune();
    // Oldest first out: a Map iterates in insertion order.
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(12).toString("base64url");
    this.codes.set(code, { chatId, group, action, expiresAt: this.now() + CODE_TTL_MS });
    return `${CODE_PREFIX}${code}`;
  }

  /** The action behind a pressed button, if it is live and pressed in its own chat; not spent. */
  peek(data: string | undefined, chatId: string): TakeResult<T> {
    if (!data?.startsWith(CODE_PREFIX)) return { ok: false };
    const held = this.codes.get(data.slice(CODE_PREFIX.length));
    if (!held || held.chatId !== chatId) return { ok: false };
    if (held.expiresAt <= this.now()) {
      this.codes.delete(data.slice(CODE_PREFIX.length));
      return { ok: false };
    }
    return { ok: true, action: held.action, group: held.group };
  }

  /** Like {@link peek}, and spends every code of the button's group. */
  take(data: string | undefined, chatId: string): TakeResult<T> {
    const found = this.peek(data, chatId);
    if (found.ok) this.dropGroup(found.group);
    return found;
  }

  dropGroup(group: string): void {
    for (const [code, held] of this.codes) if (held.group === group) this.codes.delete(code);
  }

  dropChat(chatId: string): void {
    for (const [code, held] of this.codes) if (held.chatId === chatId) this.codes.delete(code);
  }

  get size(): number {
    return this.codes.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [code, held] of this.codes) if (held.expiresAt <= now) this.codes.delete(code);
  }
}
