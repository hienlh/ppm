import type {
  TelegramUpdate,
  TelegramMessage,
  TelegramSentMessage,
  PPMBotCommand,
} from "../../types/ppmbot.ts";

const TELEGRAM_API = "https://api.telegram.org/bot";
const POLL_TIMEOUT = 25;
const MIN_EDIT_INTERVAL = 1000;
const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,50}$/;

/** Known PPMBot slash commands */
const COMMANDS = new Set([
  "start", "project", "new", "sessions", "resume",
  "status", "stop", "memory", "forget", "remember", "help",
]);

export type UpdateHandler = (update: TelegramUpdate) => Promise<void>;

export class PPMBotTelegram {
  private token: string;
  private offset = 0;
  private running = false;
  private abortController: AbortController | null = null;
  private retryCount = 0;

  /** Track last edit time per chatId:messageId to throttle */
  private lastEditTime = new Map<string, number>();

  constructor(token: string) {
    if (!BOT_TOKEN_RE.test(token)) {
      throw new Error("Invalid Telegram bot token format");
    }
    this.token = token;
  }

  // ── Polling ─────────────────────────────────────────────────────

  /** Register bot commands with Telegram so they show in the menu */
  async registerCommands(): Promise<void> {
    try {
      await this.callApi("setMyCommands", {
        commands: [
          { command: "start", description: "Greeting + list projects" },
          { command: "project", description: "Switch project" },
          { command: "new", description: "Fresh session (current project)" },
          { command: "sessions", description: "List recent sessions" },
          { command: "resume", description: "Resume a previous session" },
          { command: "status", description: "Current project/session info" },
          { command: "stop", description: "End current session" },
          { command: "memory", description: "Show project memories" },
          { command: "forget", description: "Remove matching memories" },
          { command: "remember", description: "Save a fact" },
          { command: "help", description: "Show all commands" },
        ],
      });
      console.log("[ppmbot] Commands registered");
    } catch (err) {
      console.warn("[ppmbot] Failed to register commands:", (err as Error).message);
    }
  }

  /** Start long-polling loop. Calls handler for each update. */
  async startPolling(handler: UpdateHandler): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.retryCount = 0;

    // Register commands on startup
    await this.registerCommands();

    console.log("[ppmbot] Polling started");

    while (this.running) {
      try {
        const updates = await this.getUpdates();
        this.retryCount = 0;

        for (const update of updates) {
          this.offset = update.update_id + 1;
          // Fire-and-forget: don't block polling on handler execution
          // Per-chatId serialization is handled by processing lock in service
          handler(update).catch((err) => {
            console.error("[ppmbot] Handler error:", (err as Error).message);
          });
        }
      } catch (err) {
        if (!this.running) break;
        this.retryCount++;
        const delay = Math.min(1000 * 2 ** this.retryCount, 30_000);
        console.error(
          `[ppmbot] Poll error (retry ${this.retryCount}): ${(err as Error).message}. Retrying in ${delay}ms`,
        );
        await Bun.sleep(delay);
      }
    }

    console.log("[ppmbot] Polling stopped");
  }

  /** Stop polling gracefully */
  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.lastEditTime.clear();
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ── Telegram API Methods ────────────────────────────────────────

  /** Fetch updates via long-polling */
  private async getUpdates(): Promise<TelegramUpdate[]> {
    this.abortController = new AbortController();
    const fetchTimeout = setTimeout(
      () => this.abortController?.abort(),
      (POLL_TIMEOUT + 10) * 1000,
    );

    try {
      const res = await fetch(`${TELEGRAM_API}${this.token}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset: this.offset,
          timeout: POLL_TIMEOUT,
          allowed_updates: ["message"],
        }),
        signal: this.abortController.signal,
      });

      const json = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
      if (!json.ok || !json.result) return [];
      return json.result;
    } finally {
      clearTimeout(fetchTimeout);
      this.abortController = null;
    }
  }

  /** Send a text message */
  async sendMessage(
    chatId: number | string,
    text: string,
    parseMode: "HTML" | "Markdown" = "HTML",
  ): Promise<TelegramSentMessage | null> {
    try {
      const res = await this.callApi("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      });
      const json = (await res.json()) as { ok: boolean; result?: TelegramSentMessage; description?: string };
      if (!json.ok) {
        console.error(`[ppmbot] sendMessage failed: ${json.description}`);
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      console.error(`[ppmbot] sendMessage error: ${(err as Error).message}`);
      return null;
    }
  }

  /** Edit an existing message text (throttled at 1s intervals) */
  async editMessage(
    chatId: number | string,
    messageId: number,
    text: string,
    parseMode: "HTML" | "Markdown" = "HTML",
  ): Promise<boolean> {
    const key = `${chatId}:${messageId}`;
    const now = Date.now();
    const lastEdit = this.lastEditTime.get(key) ?? 0;
    if (now - lastEdit < MIN_EDIT_INTERVAL) return false;

    this.lastEditTime.set(key, now);

    try {
      const res = await this.callApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      });
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!json.ok) {
        if (json.description?.includes("not modified")) return true;
        console.error(`[ppmbot] editMessage failed: ${json.description}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[ppmbot] editMessage error: ${(err as Error).message}`);
      return false;
    }
  }

  /** Force-edit (bypass throttle) — used for final message */
  async editMessageFinal(
    chatId: number | string,
    messageId: number,
    text: string,
    parseMode: "HTML" | "Markdown" = "HTML",
  ): Promise<boolean> {
    const key = `${chatId}:${messageId}`;
    this.lastEditTime.delete(key);
    return this.editMessage(chatId, messageId, text, parseMode);
  }

  /** Send "typing" chat action */
  async sendTyping(chatId: number | string): Promise<void> {
    try {
      await this.callApi("sendChatAction", {
        chat_id: chatId,
        action: "typing",
      });
    } catch {
      // Best-effort, ignore errors
    }
  }

  /** Delete a message */
  async deleteMessage(chatId: number | string, messageId: number): Promise<void> {
    try {
      await this.callApi("deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch {
      // Best-effort
    }
  }

  // ── Command Parsing ─────────────────────────────────────────────

  /** Parse a Telegram message into a PPMBotCommand if it starts with / */
  static parseCommand(message: TelegramMessage): PPMBotCommand | null {
    const text = message.text ?? message.caption ?? "";
    if (!text.startsWith("/")) return null;

    const match = text.match(/^\/(\w+)(?:@\S+)?\s*(.*)/s);
    if (!match) return null;

    const command = match[1]!.toLowerCase();
    if (!COMMANDS.has(command)) return null;

    return {
      command,
      args: match[2]?.trim() ?? "",
      chatId: message.chat.id,
      messageId: message.message_id,
      userId: message.from?.id ?? 0,
      username: message.from?.username,
    };
  }

  // ── Private Helpers ─────────────────────────────────────────────

  private async callApi(method: string, body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      return await fetch(`${TELEGRAM_API}${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
