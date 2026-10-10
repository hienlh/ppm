/**
 * Which Assistant session a Telegram chat talks to (one per chat, `assistant_telegram_bindings`).
 *
 * A chat with no session, or whose session is gone, gets a new one on its next message. Every
 * change is announced on `/ws/global`, so a PPM screen showing the session list can mark which
 * session is on Telegram without polling.
 */
import { chatService } from "../chat.service.ts";
import { configService } from "../config.service.ts";
import { getSessionProvider, resolveMigratedSession } from "../db.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { getAssistantSettings } from "../assistant/assistant-settings.service.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";
import { ensureAssistantWorkDir } from "../assistant/assistant-work-dir.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import { deleteTelegramBinding, getTelegramBinding, setTelegramBinding, type TelegramBinding } from "../assistant-hub/assistant-hub-db.ts";
import { broadcastGlobalEvent } from "../../server/ws/global.ts";
import { canSendTo } from "./assistant-telegram-access.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

export const BINDING_CHANGED_EVENT = "assistant:telegram_binding_changed";

export class BindingError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
  }
}

const supportsAssistant = (id: string | null | undefined): id is string =>
  !!id && providerRegistry.get(id)?.supportsAssistantSessions === true;

/** Providers that can run an Assistant session, in registry order. */
export function assistantProviderIds(): string[] {
  return providerRegistry.listAll().map((p) => p.id).filter(supportsAssistant);
}

/**
 * The provider a session the bridge creates runs on: the Assistant's own default, else the chat
 * default, if it can run an Assistant session; else the first provider that can. Creating one on
 * a provider that cannot would throw at the first message, from the phone, with nothing to fix.
 */
export function assistantProviderFor(asked?: string): string {
  if (asked) {
    if (!supportsAssistant(asked)) throw new BindingError(`"${asked}" cannot run PPM Assistant sessions`);
    return asked;
  }
  const preferred = getAssistantSettings().default_provider ?? configService.get("ai").default_provider;
  if (supportsAssistant(preferred)) return preferred;
  const first = assistantProviderIds()[0];
  if (!first) throw new BindingError("No AI provider here can run PPM Assistant sessions");
  return first;
}

/** The chat's session while it still is one, else null. */
export function boundSession(chatId: string): TelegramBinding | null {
  const binding = getTelegramBinding(chatId);
  if (!binding) return null;
  // A deleted session loses its metadata, and with it the Assistant mark.
  return isAssistantSession(binding.sessionId) ? binding : null;
}

const bindingListeners = new Set<() => void>();

/** Called after any binding changes; the returned function unsubscribes. */
export function onBindingChanged(listener: () => void): () => void {
  bindingListeners.add(listener);
  return () => { bindingListeners.delete(listener); };
}

function announce(chatId: string, sessionId: string | null, providerId: string | null): void {
  for (const listener of [...bindingListeners]) {
    try { listener(); } catch (e) { log.warn(`binding listener failed: ${(e as Error).message}`); }
  }
  broadcastGlobalEvent({ type: BINDING_CHANGED_EVENT, chatId, sessionId, providerId });
}

/** Binds a connected chat to an Assistant session, replacing the one it had. */
export function bindChat(chatId: string, sessionId: string): TelegramBinding {
  if (!canSendTo(chatId)) throw new BindingError("That Telegram chat is not connected");
  if (!isAssistantSession(sessionId)) throw new BindingError("Not a PPM Assistant session", 404);
  const providerId = getSessionProvider(resolveMigratedSession(sessionId)) ?? getSessionProvider(sessionId);
  if (!supportsAssistant(providerId)) throw new BindingError("That session's provider cannot run PPM Assistant sessions");
  setTelegramBinding(chatId, sessionId, providerId);
  log.info(`Telegram chat ${chatId} now talks to Assistant session ${sessionId}`);
  announce(chatId, sessionId, providerId);
  return getTelegramBinding(chatId)!;
}

/** Starts a new Assistant session for the chat and binds it. */
export async function startNewSession(chatId: string, providerId?: string): Promise<TelegramBinding> {
  if (!canSendTo(chatId)) throw new BindingError("That Telegram chat is not connected");
  const provider = assistantProviderFor(providerId);
  const session = await chatService.createSession(provider, {
    projectName: ASSISTANT_PROJECT_NAME,
    projectPath: ensureAssistantWorkDir(),
    adoptWarmSpare: false,
  });
  broadcastGlobalEvent({ type: "sessions:list_changed", projectName: ASSISTANT_PROJECT_NAME });
  return bindChat(chatId, session.id);
}

/** The chat's session, a new one when it has none that still exists. */
export async function ensureBoundSession(chatId: string): Promise<TelegramBinding> {
  return boundSession(chatId) ?? startNewSession(chatId);
}

/** Removes the chat's binding; false when it had none. */
export function unbindChat(chatId: string): boolean {
  const removed = deleteTelegramBinding(chatId);
  if (removed) announce(chatId, null, null);
  return removed;
}
