import { providerRegistry } from "../../providers/registry.ts";
import { chatService } from "../../services/chat.service.ts";
import { getSessionEffort, getSessionThinking, resolveMigratedSession } from "../../services/db.service.ts";
import { DEFAULT_HEADLESS_TIMEOUT_MS, extensionTurn } from "./chat-headless-turn-budget.ts";
import { createLogger } from "../../services/logger.ts";
import type { ChatSendPayload } from "../../types/api.ts";
import {
  awaitConsumerStart,
  claimConsumerStart,
  clearPendingApproval,
  countExtensionTurnsInFlight,
  endTurn,
  getOrCreateEntry,
  hasBackgroundWork,
  openTurn,
  prepareTurn,
  queueTurn,
  setPhase,
  settleConsumerStart,
  startSessionConsumer,
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
  makeEchoToAttachedClients,
  overridesDiffer,
  persistHeadlessTurnOverrides,
  validateHeadlessReply,
} from "./chat-headless-turn-helpers.ts";

const log = createLogger("chat-headless");

/** How long to wait for an idle subprocess to go after aborting it for a model change. */
const SUBPROCESS_END_WAIT_MS = 10_000;

/** How many times a call waits out another door's consumer start before giving up. */
const MAX_START_WAITS = 3;

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

/** `queued` when the call joined a live session as a follow-up instead of starting a consumer. */
export interface HeadlessTurnResult { queued: boolean }

/**
 * Run one prompt through a chat session with no browser attached, over the same persistent
 * consumer the socket drives: the run shows in `/sessions/running`, a tab attaching mid-run
 * gets the normal replay, and the turn's origin is `extension`, which is what makes its
 * approvals deny themselves instead of waiting on a person who is not there.
 */
export async function startHeadlessTurn(requestedId: string, opts: HeadlessTurnOpts, startWaits = 0): Promise<HeadlessTurnResult> {
  // Codex renames a new chat during its first turn; the entry lives under the new id.
  const sessionId = resolveMigratedSession(requestedId);
  const provider = providerRegistry.get(opts.providerId);
  if (!provider) throw new HeadlessTurnError(`Provider "${opts.providerId}" not found`, 400);
  const replyError = validateHeadlessReply(opts, sessionId);
  if (replyError) throw new HeadlessTurnError(replyError, 400);
  const entry = getOrCreateEntry(sessionId, opts.providerId, opts.projectName, opts.projectPath);
  const caller = opts.extensionId ?? REST_CALLER;
  // A looping extension must not open a subprocess per iteration until the host runs dry.
  if (countExtensionTurnsInFlight(caller, sessionId) >= MAX_HEADLESS_TURNS_PER_CALLER) {
    throw new HeadlessTurnError(TOO_MANY_HEADLESS_TURNS, 429);
  }
  // A Claude subprocess keeps the model, effort and thinking it was built with: a turn
  // running — or starting — on other picks than this message asks for is refused at once,
  // rather than run on the wrong model or waited on first.
  if (entry.phase !== "idle" && entry.providerId === "claude" && overridesDiffer(entry, sessionId, opts)) {
    throw new HeadlessTurnError(BUSY_DIFFERENT_MODEL, 409);
  }

  if (entry.consumerStart) {
    // Another door is starting the consumer; once it is live this message is a follow-up.
    if (startWaits >= MAX_START_WAITS) throw new HeadlessTurnError(BUSY_STARTING, 503);
    await awaitConsumerStart(entry);
    return startHeadlessTurn(sessionId, opts, startWaits + 1);
  }
  if (entry.isStreamingActive) return pushFollowUp(entry, sessionId, opts);

  // Claimed before the first `await` below: a message from any door meanwhile waits for this
  // consumer. The turn is the extension's from here; its budget is armed with the consumer.
  claimConsumerStart(entry);
  const turn = extensionTurn(sessionId, opts);
  openTurn(sessionId, entry, { ...turn, onStart: undefined });
  setPhase(sessionId, "initializing");
  const abandonStart = () => {
    endTurn(sessionId, entry);
    setPhase(sessionId, "idle");
    settleConsumerStart(entry);
  };
  try {
    const prep = await prepareTurn(entry, sessionId, opts, "extension", makeEchoToAttachedClients(entry, sessionId, opts.images));
    if (prep.handled) {
      abandonStart();
      return { queued: false };
    }
    persistHeadlessTurnOverrides(entry, sessionId, opts);
    await provider.resumeSession(sessionId);
    if (entry.projectPath && provider.ensureProjectPath) provider.ensureProjectPath(sessionId, entry.projectPath);

    entry.turnEvents = [];
    const permissionMode = entry.permissionMode;
    const msgModel = entry.model;
    entry.streamPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        turn.onStart?.(entry);
        startSessionConsumer(sessionId, opts.providerId, prep.content, permissionMode, opts.images, msgModel, opts.imagePaths, "extension").then(resolve, resolve);
      }, 0);
    });
    return { queued: false };
  } catch (e) {
    abandonStart();
    throw e;
  }
}

/** The aborted consumer's teardown runs on its own loop; give it `ms` to flip the flag. */
async function waitForConsumerEnd(entry: SessionEntry, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (entry.isStreamingActive && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A consumer is live for this session. A message asking Claude for other picks than the
 * idle subprocess was built with — `pushMessage` cannot change them — restarts it the way
 * `set_model` does before starting a fresh consumer; Codex takes the picks per turn.
 *
 * A message pushed while a turn runs is queued as a turn of its own: the running turn — a
 * person's above all — keeps its door, its approvals and its "done" push, and this turn's
 * origin and budget apply from the moment the provider starts it.
 */
async function pushFollowUp(entry: SessionEntry, sessionId: string, opts: HeadlessTurnOpts): Promise<HeadlessTurnResult> {
  if (entry.phase === "idle" && entry.providerId === "claude" && overridesDiffer(entry, sessionId, opts)) {
    // A background agent or shell lives in the subprocess the restart would kill: refused,
    // as every other drop of an idle subprocess is.
    if (hasBackgroundWork(sessionId)) throw new HeadlessTurnError(BUSY_BACKGROUND_WORK, 409);
    log.info(`session=${sessionId} restarting idle subprocess for new model/effort/thinking`);
    chatService.abortQuery(entry.providerId, sessionId, "headless_model_change", "extension");
    await waitForConsumerEnd(entry, SUBPROCESS_END_WAIT_MS);
    if (entry.isStreamingActive) throw new HeadlessTurnError(BUSY_DIFFERENT_MODEL, 409);
    // A fresh consumer, built with the new picks; the message is prepared there, once.
    return startHeadlessTurn(sessionId, opts);
  }

  // Behind a person's running turn the message waits its turn, their pending approval included.
  const joinsPersonsTurn = entry.phase !== "idle" && entry.turnOrigin !== "extension";
  const prep = await prepareTurn(entry, sessionId, opts, "extension", makeEchoToAttachedClients(entry, sessionId, opts.images), {
    unblockPendingApproval: !joinsPersonsTurn,
  });
  if (prep.handled) return { queued: false };
  persistHeadlessTurnOverrides(entry, sessionId, opts);

  const effort = getSessionEffort(sessionId) ?? undefined;
  const thinkingBudget = getSessionThinking(sessionId);
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
  // Armed only now that the push landed: a push that threw would leave a budget armed
  // against whatever turn runs next.
  const turn = extensionTurn(sessionId, opts);
  if (entry.phase !== "idle") {
    queueTurn(entry, turn);
    return { queued: true };
  }
  openTurn(sessionId, entry, turn);
  entry.turnEvents = [];
  clearPendingApproval(sessionId, entry);
  setPhase(sessionId, "thinking");
  return { queued: true };
}
