import { providerRegistry } from "../../providers/registry.ts";
import { resolveMigratedSession } from "../../services/db.service.ts";
import { DEFAULT_HEADLESS_TIMEOUT_MS, extensionTurn } from "./chat-headless-turn-budget.ts";
import { createLogger } from "../../services/logger.ts";
import type { ChatSendPayload } from "../../types/api.ts";
import { validateChatImages } from "../../shared/validate-chat-images.ts";
import {
  countExtensionTurnsInFlight,
  deliverExtensionMessage,
  dropIdleSubprocess,
  ensureSessionEntry,
  hasBackgroundWork,
  startCleanupTimer,
  type SessionEntry,
} from "./chat.ts";
import {
  BUSY_BACKGROUND_WORK,
  BUSY_DIFFERENT_MODEL,
  BUSY_STARTING,
  HeadlessTurnError,
  MAX_HEADLESS_TURNS_PER_CALLER,
  REST_CALLER,
  TOO_MANY_HEADLESS_TURNS,
  overridesDiffer,
  persistHeadlessTurnOverrides,
  validateHeadlessReply,
} from "./chat-headless-turn-helpers.ts";

const log = createLogger("chat-headless");

/** How long to wait for an idle subprocess to go after releasing it for a model change. */
const SUBPROCESS_END_WAIT_MS = 10_000;

export { BUSY_BACKGROUND_WORK, BUSY_DIFFERENT_MODEL, BUSY_STARTING, DEFAULT_HEADLESS_TIMEOUT_MS, HeadlessTurnError, TOO_MANY_HEADLESS_TURNS };

export interface HeadlessTurnOpts extends ChatSendPayload {
  providerId: string;
  projectName?: string;
  projectPath?: string;
  /** The extension behind the call; a REST caller has none and shares one cap. */
  extensionId?: string;
  /** Wall-clock budget in ms before the turn is force-aborted. Default 30 min. */
  timeoutMs?: number;
  /** Send the "Chat completed" push when the turn ends. Default false. */
  notifyOnDone?: boolean;
}

/** `queued` when the message joined a live session instead of opening a turn of its own. */
export interface HeadlessTurnResult { queued: boolean }

/**
 * Run one prompt through a chat session with no browser attached, through the same door a typed
 * message takes (`deliverExtensionMessage` → `deliverUserMessage` → `submitToSession`): the run
 * shows in `/sessions/running`, a tab attaching mid-run gets the normal replay, and the turn's
 * owner is `extension`, which is what makes its approvals deny themselves instead of waiting on a
 * person who is not there. Behind a running turn that is not this extension's own, the message
 * waits for that turn to end instead of steering it.
 */
export async function startHeadlessTurn(requestedId: string, opts: HeadlessTurnOpts): Promise<HeadlessTurnResult> {
  // Codex renames a new chat during its first turn; the entry lives under the new id.
  const sessionId = resolveMigratedSession(requestedId);
  if (!providerRegistry.get(opts.providerId)) throw new HeadlessTurnError(`Provider "${opts.providerId}" not found`, 400);
  const replyError = validateHeadlessReply(opts, sessionId);
  if (replyError) throw new HeadlessTurnError(replyError, 400);
  const imageError = validateChatImages(opts.images);
  if (imageError) throw new HeadlessTurnError(imageError, 400);
  const entry = ensureSessionEntry(sessionId, opts.providerId, opts.projectPath, opts.projectName);
  const caller = opts.extensionId ?? REST_CALLER;
  // A looping extension must not open a subprocess per iteration until the host runs dry.
  if (countExtensionTurnsInFlight(caller, sessionId) >= MAX_HEADLESS_TURNS_PER_CALLER) {
    throw new HeadlessTurnError(TOO_MANY_HEADLESS_TURNS, 429);
  }
  // A Claude subprocess keeps the model, effort and thinking it was built with — a pushed
  // message cannot change them. A turn running on other picks than this message asks for is
  // refused at once rather than run on the wrong model; between turns the idle subprocess is
  // released, the way a model switch releases it, and the message opens a fresh one.
  if (entry.providerId === "claude" && overridesDiffer(entry, sessionId, opts)) {
    if (entry.phase !== "idle") throw new HeadlessTurnError(BUSY_DIFFERENT_MODEL, 409);
    if (entry.isStreamingActive) await releaseForNewPicks(entry, sessionId);
  }
  persistHeadlessTurnOverrides(entry, sessionId, opts);

  const result = await deliverExtensionMessage(sessionId, entry, opts.content ?? "", {
    ...extensionTurn(sessionId, opts),
    ...(opts.images?.length ? { images: opts.images } : {}),
    ...(opts.imagePaths?.length ? { imagePaths: opts.imagePaths } : {}),
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    ...(opts.priority ? { priority: opts.priority } : {}),
  });
  // Nobody is watching: the entry goes once it is idle (a running turn re-arms this when it ends).
  if (entry.clients.size === 0) startCleanupTimer(sessionId);
  if (!result.ok) {
    const starting = /still starting/i.test(result.error);
    throw new HeadlessTurnError(starting ? BUSY_STARTING : result.error, starting ? 503 : 409);
  }
  // Queued: it joined a live session rather than starting its consumer (a PPM builtin answered
  // at once and joined nothing).
  return { queued: result.delivered !== undefined && !result.newConsumer };
}

/**
 * Release the idle Claude subprocess so the next message starts one with the new picks. A
 * background agent or shell lives in that subprocess and would die with it: refused, as every
 * other drop of an idle subprocess is.
 */
async function releaseForNewPicks(entry: SessionEntry, sessionId: string): Promise<void> {
  if (hasBackgroundWork(sessionId)) throw new HeadlessTurnError(BUSY_BACKGROUND_WORK, 409);
  log.info(`session=${sessionId} restarting idle subprocess for new model/effort/thinking`);
  dropIdleSubprocess(sessionId, "headless_model_change", "Subprocess restarted: an extension asked for another model, effort or thinking");
  const deadline = Date.now() + SUBPROCESS_END_WAIT_MS;
  while (entry.isStreamingActive && Date.now() < deadline) await Bun.sleep(25);
  if (entry.isStreamingActive) throw new HeadlessTurnError(BUSY_DIFFERENT_MODEL, 409);
}
