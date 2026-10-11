/**
 * Which Assistant session a Telegram chat talks to (one per chat, `assistant_telegram_bindings`).
 *
 * A chat with no session, or whose session is gone, gets a new one on its next message. Every
 * change is announced on `/ws/global`, so a PPM screen showing the session list can mark which
 * session is on Telegram without polling.
 */
import { chatService } from "../chat.service.ts";
import { configService } from "../config.service.ts";
import { getSessionProvider, getSessionTitle, resolveMigratedSession } from "../db.service.ts";
import type { SessionInfo } from "../../types/chat.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { getAssistantSettings } from "../assistant/assistant-settings.service.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";
import { ensureAssistantWorkDir } from "../assistant/assistant-work-dir.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import { deleteTelegramBinding, getTelegramBinding, setTelegramBinding, type TelegramBinding } from "../assistant-hub/assistant-hub-db.ts";
import { broadcastGlobalEvent } from "../../server/ws/global.ts";
import { chatLifecycle, type ChatLifecycle } from "../chat-control/chat-lifecycle.ts";
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
  announceAfterFirstTurn(session.id);
  return bindChat(chatId, session.id);
}

/** How long a new session's first turn is waited for before its second announcement is dropped. */
export const FIRST_TURN_WAIT_MS = 30 * 60_000;

/**
 * Announces the Assistant's session list again once a session the bridge created has ended its
 * first turn. The announcement at creation comes before the provider has written anything, and
 * a session's title comes from its first message (a CLI lists a session only once its transcript
 * exists), so without this an open session list shows the new conversation as "New Chat" — or
 * not at all — until something else refreshes it. Follows a provider's rename of the session.
 */
export function announceAfterFirstTurn(
  sessionId: string,
  deps: { lifecycle?: ChatLifecycle; broadcast?: (event: unknown) => void; waitMs?: number } = {},
): void {
  const lifecycle = deps.lifecycle ?? chatLifecycle;
  const broadcast = deps.broadcast ?? broadcastGlobalEvent;
  let current = sessionId;
  const offs = [
    lifecycle.on("migrated", (p) => { if (p.oldSessionId === current) current = p.newSessionId; }),
    lifecycle.on("turn_ended", (p) => {
      if (p.sessionId !== current) return;
      stop();
      broadcast({ type: "sessions:list_changed", projectName: ASSISTANT_PROJECT_NAME });
    }),
  ];
  const timer = setTimeout(() => stop(), deps.waitMs ?? FIRST_TURN_WAIT_MS);
  (timer as { unref?: () => void }).unref?.();
  function stop(): void {
    clearTimeout(timer);
    for (const off of offs.splice(0)) off();
  }
}

/** The chat's session, a new one when it has none that still exists. */
export async function ensureBoundSession(chatId: string): Promise<TelegramBinding> {
  return boundSession(chatId) ?? startNewSession(chatId);
}

/** How far down a provider's newest sessions a title is looked for when it cannot be asked by id. */
const TITLE_LOOKUP_LIMIT = 50;

/** A provider that can describe one session without listing them all (Claude's can). */
type SessionInfoById = { getSessionInfoById?: (sessionId: string, dir?: string) => Promise<SessionInfo | null> };

/**
 * The name PPM's Assistant session list shows for a session: the user's rename, else the title
 * its provider derives (summary, first message). Null when neither is known.
 */
export async function assistantSessionTitle(sessionId: string, providerId: string): Promise<string | null> {
  const renamed = getSessionTitle(sessionId);
  if (renamed) return renamed;
  const provider = providerRegistry.get(providerId);
  if (!provider) return null;
  const dir = ensureAssistantWorkDir();
  try {
    // Not on the provider interface: only some providers can look one session up.
    const byId = (provider as unknown as SessionInfoById).getSessionInfoById;
    const info = byId ? await byId.call(provider, sessionId, dir) : null;
    if (info?.title) return info.title;
    const recent = await chatService.listSessions(providerId, dir, { limit: TITLE_LOOKUP_LIMIT });
    return recent.find((s) => s.id === sessionId)?.title || null;
  } catch (e) {
    log.debug(`No title for Assistant session ${sessionId}: ${(e as Error).message}`);
    return null;
  }
}

/** Removes the chat's binding; false when it had none. */
export function unbindChat(chatId: string): boolean {
  const removed = deleteTelegramBinding(chatId);
  if (removed) announce(chatId, null, null);
  return removed;
}
