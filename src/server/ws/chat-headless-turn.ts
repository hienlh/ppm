import { providerRegistry } from "../../providers/registry.ts";
import { chatService } from "../../services/chat.service.ts";
import { logSessionEvent } from "../../services/session-log.service.ts";
import { getSessionEffort, getSessionThinking, resolveMigratedSession } from "../../services/db.service.ts";
import { createLogger } from "../../services/logger.ts";
import type { ChatSendPayload } from "../../types/api.ts";
import {
  bufferAndBroadcast,
  clearPendingApproval,
  getOrCreateEntry,
  prepareTurn,
  setPhase,
  startSessionConsumer,
  type SessionEntry,
} from "./chat.ts";
import {
  makeEchoToAttachedClients,
  overridesDiffer,
  persistHeadlessTurnOverrides,
  validateHeadlessReply,
} from "./chat-headless-turn-helpers.ts";

const log = createLogger("chat-headless");

/** Default wall-clock budget: nobody is watching to cancel a turn that never finishes. */
export const DEFAULT_HEADLESS_TIMEOUT_MS = 30 * 60_000;

/** How long to wait for an idle subprocess to go after aborting it for a model change. */
const SUBPROCESS_END_WAIT_MS = 10_000;

/** A Claude turn is running on other picks than this message asks for; refused rather than run on the wrong model. */
export const BUSY_DIFFERENT_MODEL = "BUSY_DIFFERENT_MODEL";

/**
 * Sessions with a headless turn claimed synchronously this tick. `entry.isStreamingActive`
 * flips inside `startSessionConsumer`, which runs after a `setTimeout(0)`; two calls in one
 * tick would otherwise both start a consumer. Claimed before any `await`, so the second
 * always loses the race deterministically.
 */
const headlessClaims = new Set<string>();

export function tryClaimHeadlessTurn(sessionId: string): boolean {
  if (headlessClaims.has(sessionId)) return false;
  headlessClaims.add(sessionId);
  return true;
}

export function releaseHeadlessClaim(sessionId: string): void {
  headlessClaims.delete(sessionId);
}

export interface HeadlessTurnOpts extends ChatSendPayload {
  providerId: string;
  projectName?: string;
  projectPath?: string;
  /** Wall-clock budget in ms before the turn is force-aborted. Default 30 min. */
  timeoutMs?: number;
  /** Send the "Chat completed" push when the turn ends. Default false. */
  notifyOnDone?: boolean;
}

export interface HeadlessTurnResult {
  /** True when this call joined a live session as a follow-up instead of starting a consumer. */
  queued: boolean;
}

/**
 * Run one prompt through a chat session with no browser attached, over the same persistent
 * consumer the socket drives: the run shows in `/sessions/running`, a tab attaching mid-run
 * gets the normal replay, and the turn's origin is `extension`, which is what makes its
 * approvals deny themselves instead of waiting on a person who is not there.
 */
export async function startHeadlessTurn(requestedId: string, opts: HeadlessTurnOpts, claimRetries = 0): Promise<HeadlessTurnResult> {
  // Codex renames a new chat during its first turn; the entry lives under the new id.
  const sessionId = resolveMigratedSession(requestedId);
  const provider = providerRegistry.get(opts.providerId);
  if (!provider) throw new Error(`Provider "${opts.providerId}" not found`);
  const replyError = validateHeadlessReply(opts, sessionId);
  if (replyError) throw new Error(replyError);
  const entry = getOrCreateEntry(sessionId, opts.providerId, opts.projectName, opts.projectPath);

  if (entry.isStreamingActive) return pushFollowUp(entry, sessionId, opts);
  if (!tryClaimHeadlessTurn(sessionId)) {
    // Lost the same-tick race: the winner has not started its consumer yet. Returning
    // "queued" would drop the message, so wait one tick and re-enter as a real follow-up.
    if (claimRetries >= 3) throw new Error("Session is busy starting another turn — retry shortly");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return startHeadlessTurn(sessionId, opts, claimRetries + 1);
  }
  // Claimed before the first `await` below — see `headlessClaims`.
  entry.isStreamingActive = true;
  try {
    const prep = await prepareTurn(entry, sessionId, opts, "extension", makeEchoToAttachedClients(entry, sessionId, opts.images));
    if (prep.handled) {
      entry.isStreamingActive = false;
      releaseHeadlessClaim(sessionId);
      return { queued: false };
    }
    persistHeadlessTurnOverrides(entry, sessionId, opts);
    await provider.resumeSession(sessionId);
    if (entry.projectPath && provider.ensureProjectPath) provider.ensureProjectPath(sessionId, entry.projectPath);

    entry.turnEvents = [];
    setPhase(sessionId, "initializing");
    beginExtensionTurn(entry, sessionId, opts);
    const msgModel = entry.model;
    entry.streamPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        startSessionConsumer(sessionId, opts.providerId, prep.content, opts.permissionMode, opts.images, msgModel, opts.imagePaths, "extension").then(resolve, resolve);
      }, 0);
    });
    return { queued: false };
  } catch (e) {
    entry.isStreamingActive = false;
    releaseHeadlessClaim(sessionId);
    throw e;
  }
}

/**
 * Marks the turn an extension's, arms its wall-clock budget and ties both the budget and the
 * claim to this turn's end — not to the consumer's, which for a real provider only ends when
 * the session is torn down.
 */
function beginExtensionTurn(entry: SessionEntry, sessionId: string, opts: HeadlessTurnOpts): void {
  entry.turnOrigin = "extension";
  entry.notifyOnDone = opts.notifyOnDone === true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HEADLESS_TIMEOUT_MS;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    budgetTimer = undefined;
    if (entry.phase === "idle") return;
    logSessionEvent(sessionId, "ERROR", `Headless turn cancelled: exceeded ${timeoutMs}ms wall-clock budget`);
    chatService.abortQuery(entry.providerId, sessionId, "headless_timeout", "extension");
    bufferAndBroadcast(sessionId, {
      type: "error",
      message: `Headless turn cancelled: exceeded the ${Math.round(timeoutMs / 1000)}s wall-clock budget`,
    });
  }, timeoutMs);
  (entry.onTurnEnd ??= new Set()).add(() => {
    if (budgetTimer) { clearTimeout(budgetTimer); budgetTimer = undefined; }
    releaseHeadlessClaim(sessionId);
  });
}

/** The aborted consumer's teardown runs on its own loop; give it `ms` to flip the flag. */
async function waitForConsumerEnd(entry: SessionEntry, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (entry.isStreamingActive && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A consumer is live for this session. A Claude subprocess keeps the model, effort and
 * thinking it was built with — `pushMessage` cannot change them — so a message asking for
 * others is refused while a turn runs and, between turns, restarts the subprocess the way
 * `set_model` does before starting a fresh consumer. Codex takes the picks per turn.
 */
async function pushFollowUp(entry: SessionEntry, sessionId: string, opts: HeadlessTurnOpts): Promise<HeadlessTurnResult> {
  if (entry.providerId === "claude" && overridesDiffer(entry, sessionId, opts)) {
    if (entry.phase !== "idle") throw new Error(BUSY_DIFFERENT_MODEL);
    log.info(`session=${sessionId} restarting idle subprocess for new model/effort/thinking`);
    chatService.abortQuery(entry.providerId, sessionId, "headless_model_change", "extension");
    await waitForConsumerEnd(entry, SUBPROCESS_END_WAIT_MS);
    if (entry.isStreamingActive) throw new Error(BUSY_DIFFERENT_MODEL);
    // A fresh consumer, built with the new picks; the message is prepared there, once.
    return startHeadlessTurn(sessionId, opts);
  }

  const prep = await prepareTurn(entry, sessionId, opts, "extension", makeEchoToAttachedClients(entry, sessionId, opts.images));
  if (prep.handled) return { queued: false };
  persistHeadlessTurnOverrides(entry, sessionId, opts);

  const effort = getSessionEffort(sessionId) ?? undefined;
  const thinkingBudget = getSessionThinking(sessionId);
  const opensTurn = entry.phase === "idle";
  if (opensTurn) beginExtensionTurn(entry, sessionId, opts);
  else entry.turnOrigin = "extension";
  await chatService.pushMessage(entry.providerId, sessionId, prep.content, {
    origin: "extension",
    priority: opts.priority ?? "next",
    images: opts.images,
    imagePaths: opts.imagePaths,
    ...(entry.model ? { model: entry.model } : {}),
    ...(effort ? { effort } : {}),
    ...(thinkingBudget != null ? { thinkingBudget } : {}),
  });
  // Unblocking a pending approval can end the running turn while the push is prepared; a
  // consumer that ended meanwhile has nothing left to drive, so the phase stays idle.
  if (!entry.isStreamingActive) {
    log.warn(`session=${sessionId} consumer ended while the follow-up was pushed`);
    return { queued: true };
  }
  entry.turnEvents = [];
  clearPendingApproval(sessionId, entry);
  setPhase(sessionId, "thinking");
  return { queued: true };
}
