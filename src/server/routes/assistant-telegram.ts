import { Hono } from "hono";
import { getSessionTitle } from "../../services/db.service.ts";
import { reachableChats } from "../../services/assistant-telegram/assistant-telegram-access.ts";
import { BindingError, bindChat, boundSession } from "../../services/assistant-telegram/assistant-telegram-binding.ts";
import { assistantTelegramBridge, assistantTelegramConfig } from "../../services/assistant-telegram/assistant-telegram.service.ts";
import { ok, err } from "../../types/api.ts";

/**
 * The Telegram side of PPM Assistant (`/api/assistant/telegram`), behind PPM's auth: which chats
 * are connected and which conversation each one talks to, and "use this conversation on
 * Telegram". Only connected private chats are listed or accepted.
 */
export const assistantTelegramRoutes = new Hono();

const ID_RE = /^[\w.:-]{1,256}$/;

assistantTelegramRoutes.get("/", (c) => {
  try {
    const chats = reachableChats().map((chat) => {
      const bound = boundSession(chat.chatId);
      return {
        chatId: chat.chatId,
        name: chat.name,
        sessionId: bound?.sessionId ?? null,
        sessionTitle: bound ? getSessionTitle(bound.sessionId) : null,
      };
    });
    return c.json(ok({
      enabled: assistantTelegramConfig().enabled,
      running: assistantTelegramBridge.running,
      error: assistantTelegramBridge.lastError,
      chats,
    }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

assistantTelegramRoutes.post("/bind", async (c) => {
  let body: { sessionId?: unknown; chatId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Body must be JSON"), 400);
  }
  if (typeof body?.sessionId !== "string" || !ID_RE.test(body.sessionId)) return c.json(err("sessionId is required"), 400);
  if (body.chatId !== undefined && (typeof body.chatId !== "string" || !/^\d{1,20}$/.test(body.chatId))) {
    return c.json(err("chatId must be a Telegram chat id"), 400);
  }
  let chatId = body.chatId as string | undefined;
  if (chatId === undefined) {
    const chats = reachableChats();
    if (chats.length === 0) return c.json(err("No Telegram chat is connected"), 400);
    if (chats.length > 1) return c.json(err("Several Telegram chats are connected: say which one (chatId)"), 400);
    chatId = chats[0]!.chatId;
  }
  try {
    const binding = bindChat(chatId, body.sessionId);
    return c.json(ok({ chatId: binding.telegramChatId, sessionId: binding.sessionId, providerId: binding.providerId }));
  } catch (e) {
    if (e instanceof BindingError) return c.json(err(e.message), e.status);
    return c.json(err((e as Error).message), 500);
  }
});
