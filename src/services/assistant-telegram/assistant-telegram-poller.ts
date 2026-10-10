/**
 * Reads the bot's updates, and confirms each to Telegram only once it was handed on.
 *
 * Telegram forgets an update as soon as a poll asks past it. So the poll's offset never passes
 * an update still waiting (in a debounce, behind a slow message of the same chat); while one
 * waits, Telegram keeps returning it, and the poll — which then has nothing new — sleeps briefly
 * instead of spinning. The offset is saved after each change, so a restart neither runs a message
 * twice nor loses one that had not reached the Assistant.
 */
import type { TelegramBotClient } from "../telegram/telegram-bot-client.ts";
import type { TelegramUpdate } from "../telegram/telegram-types.ts";
import type { BridgeStateStore } from "./assistant-telegram-state.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

/** While an update waits it is not confirmed, so Telegram keeps returning it at once. */
const WAIT_FOR_DELIVERY_MS = 250;

export class AssistantTelegramPoller {
  private readonly seen = new Set<number>();
  private readonly undelivered = new Set<number>();
  private nextOffset: number;
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;
  /** Why the bot could not be read, for Settings; null while it is. */
  lastError: string | null = null;

  constructor(
    private readonly client: TelegramBotClient,
    private readonly state: BridgeStateStore,
    private readonly dispatch: (update: TelegramUpdate) => void,
  ) {
    this.nextOffset = state.offset;
  }

  start(timeoutS: number): void {
    this.loop ??= this.poll(timeoutS);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop?.catch(() => {});
  }

  /** The update reached the Assistant or was answered: it may be confirmed. */
  delivered(updateId: number): void {
    this.undelivered.delete(updateId);
    this.advance();
  }

  private advance(): void {
    const waiting = this.undelivered.size ? Math.min(...this.undelivered) : null;
    const maxSeen = this.seen.size ? Math.max(...this.seen) : this.nextOffset - 1;
    const next = waiting ?? Math.max(this.nextOffset, maxSeen + 1);
    if (next !== this.nextOffset) {
      this.nextOffset = next;
      this.state.setOffset(next);
    }
    for (const id of this.seen) if (id < next - 1) this.seen.delete(id);
  }

  private async poll(timeoutS: number): Promise<void> {
    const signal = this.abort.signal;
    let conflictLogged = false;
    while (!signal.aborted) {
      const res = await this.client.getUpdates(this.nextOffset, this.undelivered.size ? 0 : timeoutS, signal);
      if (signal.aborted) return;
      if (!res.ok) {
        // 409: a webhook on this bot, or another program reading it.
        this.lastError = res.errorCode === 409 ? "Another program is reading this bot's messages." : res.description;
        if (res.errorCode === 401 || res.errorCode === 404) {
          log.error(`Telegram refused the bot token (${res.errorCode}); stopped reading`);
          return;
        }
        if (res.errorCode !== 409 || !conflictLogged) log.warn(`Telegram getUpdates failed: ${res.errorCode ?? "network"} ${res.description}`);
        conflictLogged ||= res.errorCode === 409;
        await Bun.sleep(res.errorCode === 409 ? 5000 : 3000);
        continue;
      }
      this.lastError = null;
      let fresh = 0;
      for (const update of res.result) {
        if (update.update_id < this.nextOffset || this.seen.has(update.update_id)) continue;
        fresh++;
        this.seen.add(update.update_id);
        this.undelivered.add(update.update_id);
        this.dispatch(update);
      }
      this.advance();
      if (fresh === 0 && this.undelivered.size) await Bun.sleep(WAIT_FOR_DELIVERY_MS);
    }
  }
}
