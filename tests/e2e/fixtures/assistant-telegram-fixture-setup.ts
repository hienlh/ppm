/**
 * The Telegram half of the Assistant e2e fixture (`assistant-server.ts` with
 * PPM_ASSISTANT_FAKE_TELEGRAM=1): the Assistant's bot pointed at a fake Bot API, the bridge
 * switched on, private chats already connected, and what the e2e reads back about pushes, watches
 * and bindings. The bridge itself is started by `startAssistantHub()`, the server's own startup.
 *
 * Imported only after `assistant-server.ts` has checked that PPM_HOME and HOME are scratch
 * directories, so every write here lands in the throwaway database.
 */
import { BOT_TOKEN_RE, parseLoopbackApiBase, TELEGRAM_API_BASE_ENV } from "../../../src/services/telegram/telegram-api-base";
import type { BridgeStartOptions } from "../../../src/services/assistant-telegram/assistant-telegram.service";

const env = process.env;

/** A connected chat as the e2e seeds it: `[chatId, userId, name]`; an empty user id is a row an older PPM wrote. */
type SeededChat = [string, string, string];

export interface TelegramFixture {
  bridge: BridgeStartOptions;
  /** Handles `/__assistant-test/<route>` for the Telegram e2e; null for a route it does not own. */
  route(req: Request, route: string): Promise<Response | null>;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function setupFakeTelegram(opts: { resuming: boolean }): Promise<TelegramFixture> {
  // The bot token travels in every Bot API URL: refuse anything but a loopback fake.
  const base = parseLoopbackApiBase(env[TELEGRAM_API_BASE_ENV] ?? "");
  if (!base) throw new Error(`${TELEGRAM_API_BASE_ENV} must name the loopback fake Bot API`);
  const token = env.PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN ?? "";
  if (!BOT_TOKEN_RE.test(token)) throw new Error("PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN must be a bot token of the fake's");

  const { configService } = await import("../../../src/services/config.service");
  const { setPPMBotBot } = await import("../../../src/services/telegram-bots");
  const { upsertApprovedPairing, getDb } = await import("../../../src/services/db.service");
  if (!opts.resuming) {
    setPPMBotBot({ bot_token: token, bot_username: "ppm_e2e_bot" });
    configService.set("clawbot", { enabled: true, show_tool_calls: true, debounce_ms: Number(env.PPM_ASSISTANT_FAKE_TELEGRAM_DEBOUNCE_MS ?? 300) } as never);
    // Delivered at once: a push the e2e waits a minute for proves nothing more.
    configService.set("notifications", { ...(configService.get("notifications") as object), delay_seconds: 0 } as never);
    const chats = JSON.parse(env.PPM_ASSISTANT_FAKE_TELEGRAM_CHATS ?? "[]") as SeededChat[];
    for (const [chatId, userId, name] of chats) {
      if (userId) upsertApprovedPairing(chatId, userId, name);
      // A row from before PPM recorded who connected a chat: no user id at all.
      else getDb().query(`INSERT INTO clawbot_paired_chats (telegram_chat_id, telegram_user_id, display_name, pairing_code, status, approved_at)
        VALUES (?, NULL, ?, NULL, 'approved', unixepoch())`).run(chatId, name);
    }
  }

  // What a phone would be sent as a web push, kept instead of sent (no device is subscribed).
  const pushes: Array<{ at: number; title: string; body: string; path?: string; sessionId?: string }> = [];
  const { webPushService } = await import("../../../src/services/web-push/web-push.service");
  webPushService.send = (async (message: { title: string; body: string; path?: string; sessionId?: string }) => {
    pushes.push({ at: Date.now(), title: message.title, body: message.body, path: message.path, sessionId: message.sessionId });
    return { sent: 1, failed: 0, removed: 0 };
  }) as typeof webPushService.send;

  // Shorter clocks for the watch service, which the hub starts: the same code, minutes become seconds.
  const { assistantWatchService } = await import("../../../src/services/assistant-watch/assistant-watch.service");
  const clocks = assistantWatchService as unknown as Record<string, number>;
  if (env.PPM_ASSISTANT_FIXTURE_WATCH_RETRY_MS) clocks.retryDelayMs = Number(env.PPM_ASSISTANT_FIXTURE_WATCH_RETRY_MS);
  if (env.PPM_ASSISTANT_FIXTURE_WATCH_TICK_MS) clocks.tickMs = Number(env.PPM_ASSISTANT_FIXTURE_WATCH_TICK_MS);

  // Telegram's own waits (a 60 s `retry_after`) scaled down; a draft is still edited once a second.
  const scale = Number(env.PPM_ASSISTANT_FIXTURE_TG_DELAY_SCALE ?? 1);
  const bridge: BridgeStartOptions = scale > 0 && scale < 1 ? { scaleDelay: (ms) => ms * scale } : {};

  const db = await import("../../../src/services/db.service");
  const hub = await import("../../../src/services/assistant-hub/assistant-hub-db");
  const { chatControl } = await import("../../../src/services/chat-control/chat-control");
  const { assistantTelegramBridge } = await import("../../../src/services/assistant-telegram/assistant-telegram.service");

  return {
    bridge,
    async route(req, route) {
      if (route === "pushes") return json(pushes);
      if (route === "watches") return json(hub.listAssistantWatches());
      if (route === "bindings") return json(hub.listTelegramBindings());
      if (route === "live") return json(chatControl()?.listLive() ?? []);
      if (route === "bridge") return json({ running: assistantTelegramBridge.running, lastError: assistantTelegramBridge.lastError });
      if (route === "paired") return json(db.getApprovedPairedChats().map((c) => ({ chatId: c.telegram_chat_id, userId: c.telegram_user_id, status: c.status })));
      // The name a user gives a chat (PPM's title table), without the provider's own rename.
      if (route === "title" && req.method === "POST") {
        const b = await req.json() as { sessionId: string; title: string };
        db.setSessionTitle(b.sessionId, b.title);
        return json({ ok: true });
      }
      // A chat PPM knows only from its database: finished, unread, never opened in this process.
      if (route === "seed-unread" && req.method === "POST") {
        const b = await req.json() as { sessionId: string; project: string; path: string; providerId: string; title: string };
        db.setSessionMetadata(b.sessionId, b.project, b.path);
        db.setSessionProvider(b.sessionId, b.providerId);
        db.setSessionTitle(b.sessionId, b.title);
        db.incrementSessionUnread(b.sessionId, "done", b.title, b.project);
        return json({ ok: true });
      }
      return null;
    },
  };
}
