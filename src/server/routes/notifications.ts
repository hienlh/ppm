/**
 * Settings → Notifications: what to notify about and when, browsers that receive
 * push, the Telegram chats that receive alerts, and the ntfy topic they are published to.
 *
 * Saving the bot token and sending a Telegram test keep their existing routes under
 * /api/settings (`/telegram`, `/telegram/test`).
 */
import { Hono } from "hono";
import { configService } from "../../services/config.service.ts";
import { parsePushSubscription, webPushService } from "../../services/web-push/web-push.service.ts";
import { notifyConnect, TelegramConnectError } from "../../services/telegram-connect.service.ts";
import { getPPMBotBot, listNotifyChats, removeNotifyChat, sameBot } from "../../services/telegram-bots.ts";
import { checkNtfyServer, NtfyError, ntfyService } from "../../services/ntfy-notification.service.ts";
import {
  applyNotificationSettingsPatch,
  normalizeNtfyServer,
  NTFY_TOPIC_RE,
  parseNotificationSettingsPatch,
  resolveNotificationSettings,
  type NtfyStatus,
  type PushStatus,
  type TelegramNotifyStatus,
} from "../../shared/notification-settings.ts";
import { ok, err } from "../../types/api.ts";
import type { NtfyConfig, TelegramConfig } from "../../types/config.ts";

export const notificationRoutes = new Hono();

function deviceName(): string {
  return (configService.get("device_name") as string) || "PPM";
}

/** Only an http(s) origin, normalised; anything else is refused. */
function pageOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

notificationRoutes.get("/settings", (c) => {
  return c.json(ok(resolveNotificationSettings(configService.get("notifications"))));
});

notificationRoutes.put("/settings", async (c) => {
  const parsed = parseNotificationSettingsPatch(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json(err(parsed.error), 400);
  const next = applyNotificationSettingsPatch(resolveNotificationSettings(configService.get("notifications")), parsed.patch);
  configService.set("notifications", next);
  return c.json(ok(next));
});

notificationRoutes.get("/push", async (c) => {
  const status: PushStatus = { publicKey: await webPushService.publicKey(), devices: webPushService.devices() };
  return c.json(ok(status));
});

notificationRoutes.post("/push/subscribe", async (c) => {
  const body = await c.req.json<{ subscription?: unknown; label?: unknown; origin?: unknown }>().catch(() => null);
  const parsed = parsePushSubscription(body?.subscription);
  if (!parsed.ok) return c.json(err(parsed.error), 400);
  // Where a click on the notification should open PPM again — the page the user is on.
  const origin = pageOrigin(body?.origin);
  if (!origin) return c.json(err("Missing page origin"), 400);
  const label = typeof body?.label === "string" ? body.label : "";
  return c.json(ok(await webPushService.subscribe(parsed.value, label, origin)));
});

notificationRoutes.post("/push/unsubscribe", async (c) => {
  const body = await c.req.json<{ endpoint?: unknown; id?: unknown }>().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : undefined;
  const id = typeof body?.id === "string" ? body.id : undefined;
  if (!endpoint && !id) return c.json(err("Pass an endpoint or a device id"), 400);
  return c.json(ok({ removed: webPushService.unsubscribe({ endpoint, id }) }));
});

notificationRoutes.post("/push/test", async (c) => {
  const body = await c.req.json<{ id?: unknown }>().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : null;
  if (id && !webPushService.devices().some((d) => d.id === id)) return c.json(err("Unknown device"), 404);
  const result = await webPushService.send(
    {
      title: `Test · ${deviceName()}`,
      body: "Push notifications from PPM are working.",
      path: "/",
      tag: "ppm-test",
      project: "",
      sessionId: "",
      providerId: "",
      urgency: "normal",
    },
    id ? (d) => d.id === id : undefined,
  );
  if (result.sent === 0) {
    const reason = id ? webPushService.devices().find((d) => d.id === id)?.lastError : null;
    const message = reason
      ?? (result.removed > 0 ? "That browser is no longer subscribed. Turn push on again there." : "No browser has push turned on.");
    return c.json(err(message), 502);
  }
  return c.json(ok(result));
});

notificationRoutes.get("/telegram", async (c) => {
  const config = (configService.get("telegram") as TelegramConfig | undefined) ?? { bot_token: "" };
  // Tokens saved before PPM stored the bot's name get it now, the first time it is needed.
  const botUsername = config.bot_token
    ? config.bot_username ?? await notifyConnect.botUsername().catch(() => null)
    : null;
  const status: TelegramNotifyStatus = {
    configured: !!config.bot_token,
    botUsername,
    sharedWithPPMBot: !!config.bot_token && sameBot(config.bot_token, getPPMBotBot().bot_token),
    chats: listNotifyChats().map(({ chatId, name }) => ({ chatId, name })),
    connect: notifyConnect.status(),
  };
  return c.json(ok(status));
});

notificationRoutes.post("/telegram/connect", async (c) => {
  try {
    return c.json(ok(await notifyConnect.start()));
  } catch (e) {
    if (e instanceof TelegramConnectError) return c.json(err(e.message), e.status);
    throw e;
  }
});

notificationRoutes.delete("/telegram/connect", (c) => {
  notifyConnect.cancel();
  return c.json(ok({ cancelled: true }));
});

/** Stop sending alerts to a chat. The Assistant's chats are not this list: see Settings → PPM Assistant → Telegram. */
notificationRoutes.delete("/telegram/chats/:chatId", (c) => {
  if (!removeNotifyChat(c.req.param("chatId"))) return c.json(err("That chat is not connected"), 404);
  return c.json(ok({ removed: true }));
});

const NO_NTFY: NtfyConfig = { server: "", topic: "", token: "" };

function ntfyStatus(): NtfyStatus {
  const config = configService.get("ntfy") ?? NO_NTFY;
  return { configured: !!(config.server && config.topic), server: config.server, topic: config.topic, tokenSet: !!config.token };
}

notificationRoutes.get("/ntfy", (c) => c.json(ok(ntfyStatus())));

/**
 * Save the server, topic and token once the server answers as ntfy and takes the token.
 * A token left out is kept, unless the server changed: it belongs to the old server and
 * is never sent to another one.
 */
notificationRoutes.put("/ntfy", async (c) => {
  const body = await c.req.json<{ server?: unknown; topic?: unknown; token?: unknown }>().catch(() => null);
  const server = typeof body?.server === "string" ? normalizeNtfyServer(body.server) : null;
  if (!server) return c.json(err("Enter the server's address, such as https://ntfy.sh"), 400);
  const topic = typeof body?.topic === "string" ? body.topic.trim() : "";
  if (!NTFY_TOPIC_RE.test(topic)) return c.json(err("A topic is 1 to 64 letters, digits, - or _"), 400);
  if (body?.token !== undefined && typeof body.token !== "string") return c.json(err("token must be a string"), 400);

  const current = configService.get("ntfy") ?? NO_NTFY;
  const token = typeof body?.token === "string" ? body.token.trim() : current.server === server ? current.token : "";
  if (/\s/.test(token)) return c.json(err("An access token has no spaces in it"), 400);

  const next: NtfyConfig = { server, topic, token };
  try {
    await checkNtfyServer(next);
  } catch (e) {
    if (e instanceof NtfyError) return c.json(err(e.message), e.status);
    throw e;
  }
  configService.set("ntfy", next);
  return c.json(ok(ntfyStatus()));
});

notificationRoutes.delete("/ntfy", (c) => {
  configService.set("ntfy", { ...NO_NTFY });
  return c.json(ok(ntfyStatus()));
});

notificationRoutes.post("/ntfy/test", async (c) => {
  try {
    await ntfyService.sendTest();
    return c.json(ok({ sent: true }));
  } catch (e) {
    if (e instanceof NtfyError) return c.json(err(e.message), e.status);
    throw e;
  }
});
