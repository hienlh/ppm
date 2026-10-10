import { createDeviceBroker } from "../tab-tools-mcp/tab-open-broker.ts";
import { ASSISTANT_MCP_TIMEOUT_MS } from "./assistant-mcp-tools.ts";
import type { ApprovalSummary, EndpointApprovalRequest } from "../../shared/assistant-approval.ts";

/**
 * Approvals the PPM Assistant's tool endpoint asks for before it changes anything, the same way
 * for Claude and Codex: the tool call puts a card on the Assistant session (`ws/chat.ts` holds it
 * as the session's pending approval, shows it on every device showing the session, and sends a
 * notification), then waits — its HTTP call held open — for the first device to answer.
 *
 * A card waits until it is answered, however long that takes: the user may be away from every
 * device, and a question that expires on its own only makes them ask the agent again. What
 * ends it otherwise is the turn or the call going away — and a PPM restart, which drops every
 * waiting request with the process (an answer to one then gets "no longer valid").
 *
 * A call ends one of five ways, and only `approved` runs anything:
 *  - approved / denied: a device answered;
 *  - withdrawn: the agent's HTTP call closed, the user stopped the turn or typed a message
 *    instead, or the turn ended;
 *  - unavailable: the card could not be shown at all (no such session, too many waiting);
 *  - timeout: only under {@link APPROVAL_TIMEOUT_ENV}, which tests set so that a card nobody
 *    answers can end within the test.
 *
 * Built on the device broker, so a session is known by the id it goes by now (Codex renames a
 * new chat during its first turn) and an answer counts only from the session it was asked in.
 */

export const APPROVAL_TIMEOUT_ENV = "PPM_ASSISTANT_APPROVAL_TIMEOUT_MS";
export const MAX_APPROVALS_IN_FLIGHT_PER_SESSION = 4;
export const MAX_APPROVALS_PER_MINUTE = 20;

/**
 * How long a shown card waits for its answer: without limit (null), unless the environment
 * names a limit — for tests and e2e fixtures, which cannot wait for nobody. A limit is held
 * under the providers' own tool timeout, so the agent hears this broker's reply rather than the
 * provider's bare one.
 */
export function approvalTimeoutMs(env: Record<string, string | undefined> = process.env): number | null {
  const raw = Number(env[APPROVAL_TIMEOUT_ENV]);
  return Number.isInteger(raw) && raw >= 100 && raw < ASSISTANT_MCP_TIMEOUT_MS ? raw : null;
}

/** "10 minutes", or "40 seconds" under a minute. */
function minutesOrSeconds(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const [n, unit] = seconds >= 60 ? [Math.round(seconds / 60), "minute"] : [seconds, "second"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export type ApprovalVerdict =
  | { verdict: "approved" }
  | { verdict: "denied" | "timeout" | "withdrawn" | "unavailable"; reason: string };

/** What a tool asks the user to approve. `summary` is server-built (`assistant-approval-summary.ts`). */
export interface ApprovalAsk {
  tool: string;
  input: Record<string, unknown>;
  summary: ApprovalSummary;
}

/** Asks the user of one Assistant session; what the endpoint hands each tool that may change something. */
export type AskApproval = (ask: ApprovalAsk) => Promise<ApprovalVerdict>;

interface ApprovalAnswer {
  requestId: string;
  approved: boolean;
}

/**
 * Puts the card on the session; 1 when the session exists to hold it, 0 otherwise. The card may
 * only be queued; whoever puts it on the screen calls the broker's `shown`, which starts its
 * answer window when there is one.
 */
export type ApprovalDelivery = (sessionId: string, request: EndpointApprovalRequest) => number;
/** Told when a shown card's request ends, however it ended, so the card can go. */
export type ApprovalEnded = (sessionId: string, requestId: string, approved: boolean) => void;

export const DENIED_MESSAGE = "The user declined. Nothing was done; do not try again or reach the same result another way unless the user asks.";

export function createApprovalBroker(opts: {
  deliver: ApprovalDelivery;
  onEnd?: ApprovalEnded;
  canonical?: (sessionId: string) => string;
  now?: () => number;
  /** How long a shown card waits for its answer; null: until it is answered or withdrawn. */
  timeoutMs?: () => number | null;
}) {
  const timeoutMs = opts.timeoutMs ?? (() => approvalTimeoutMs());
  /**
   * Requests delivered and not yet ended, each with its answer timer once shown under a limit. A
   * card queued behind another one waits there without any limit: it is the earlier card the
   * user has not answered yet, not this one.
   */
  const waiting = new Map<string, { shown: boolean; timer?: ReturnType<typeof setTimeout> }>();

  function trackDelivered(requestId: string): void {
    waiting.set(requestId, { shown: false });
  }

  /**
   * The card is on the user's screen now: its answer window, when there is one, starts here.
   * Showing the same card again (a reconnecting device) changes nothing.
   */
  function shown(requestId: string): void {
    const entry = waiting.get(requestId);
    if (!entry || entry.shown) return;
    entry.shown = true;
    const window = timeoutMs();
    if (window === null) return;
    entry.timer = setTimeout(() => inner.cancel(requestId, {
      reason: "timeout",
      message: `The user did not answer within ${minutesOrSeconds(window)}. Nothing was done; do not ask again unless the user asks.`,
    }), window);
  }

  function untrack(requestId: string): void {
    const entry = waiting.get(requestId);
    if (entry?.timer) clearTimeout(entry.timer);
    waiting.delete(requestId);
  }

  const inner = createDeviceBroker<EndpointApprovalRequest, ApprovalAnswer, ApprovalAsk>({
    // Tracked before the card is offered: offering it to an empty slot shows it at once, and
    // that `shown` has to find the request already waiting.
    deliver: (sessionId, request) => {
      trackDelivered(request.requestId);
      let reached = 0;
      try {
        reached = opts.deliver(sessionId, request);
      } finally {
        if (reached === 0) untrack(request.requestId);
      }
      return reached;
    },
    build: (requestId, ask) => ({
      type: "approval_request", requestId, tool: ask.tool, input: ask.input, summary: ask.summary, origin: "endpoint",
    }),
    messages: {
      noDevice: "The approval card could not be shown: this Assistant session is not running in PPM. Nothing was done.",
      busy: "Too many approvals are already waiting in this session; wait for the user to answer them. Nothing was done.",
      rateLimited: (perMinute) => `Approval was asked ${perMinute} times in the last minute; wait before asking again. Nothing was done.`,
      // Never heard: requests are made with no device-broker deadline (see `request`), and the
      // only answer window is the one `shown` arms.
      timeout: () => "The user did not answer. Nothing was done; do not ask again unless the user asks.",
      withdrawn: "The request was withdrawn before the user answered. Nothing was done.",
    },
    logTag: "assistant-approval",
    onEnd: (sessionId, requestId, outcome) => {
      untrack(requestId);
      opts.onEnd?.(sessionId, requestId, outcome.ok && outcome.result.approved);
    },
    canonical: opts.canonical,
    now: opts.now,
    maxPending: 64,
    maxInFlightPerSession: MAX_APPROVALS_IN_FLIGHT_PER_SESSION,
    perMinute: MAX_APPROVALS_PER_MINUTE,
  });

  /** Asks the session's user; resolves once they answer or the request ends without an answer. */
  async function request(sessionId: string, ask: ApprovalAsk, signal?: AbortSignal): Promise<ApprovalVerdict> {
    const outcome = await inner.request(sessionId, ask, Number.POSITIVE_INFINITY, signal);
    if (outcome.ok) return outcome.result.approved ? { verdict: "approved" } : { verdict: "denied", reason: DENIED_MESSAGE };
    if (outcome.reason === "timeout") return { verdict: "timeout", reason: outcome.message };
    if (outcome.reason === "withdrawn") return { verdict: "withdrawn", reason: outcome.message };
    return { verdict: "unavailable", reason: outcome.message };
  }

  return {
    request,
    /** A device's answer; false when nothing with that id waits in that session (first answer wins). */
    settle: (sessionId: string, requestId: string, approved: boolean): boolean => inner.settle(sessionId, { requestId, approved }),
    /** Ends a waiting request unanswered, telling its tool `message`; false when it is not waiting. */
    withdraw: (requestId: string, message: string): boolean => inner.cancel(requestId, { reason: "withdrawn", message }),
    /** The card for `requestId` was put on the user's screen; its answer window, if any, starts now. */
    shown,
    owns: inner.owns,
    pendingFor: inner.pendingFor,
    pendingCount: inner.pendingCount,
    forget: inner.forget,
  };
}

export type ApprovalBroker = ReturnType<typeof createApprovalBroker>;

let delivery: ApprovalDelivery | null = null;
let ended: ApprovalEnded | null = null;
let resolveSession: (sessionId: string) => string = (sessionId) => sessionId;

/** `ws/chat.ts` owns the sessions' cards; it registers how to show one and how to take it away. */
export function setAssistantApprovalDelivery(
  deliver: ApprovalDelivery | null,
  onEnd: ApprovalEnded | null,
  canonical?: (sessionId: string) => string,
): void {
  delivery = deliver;
  ended = onEnd;
  resolveSession = canonical ?? ((sessionId) => sessionId);
}

export const assistantApprovalBroker = createApprovalBroker({
  deliver: (sessionId, req) => delivery?.(sessionId, req) ?? 0,
  onEnd: (sessionId, requestId, approved) => ended?.(sessionId, requestId, approved),
  canonical: (sessionId) => resolveSession(sessionId),
});

/** The asker one tool call gets: bound to its session and to the HTTP call it answers. */
export function approvalAskerFor(sessionId: string, signal?: AbortSignal, broker: ApprovalBroker = assistantApprovalBroker): AskApproval {
  return (ask) => broker.request(sessionId, ask, signal);
}

/** The asker a tool falls back to outside an Assistant session's call: nobody to ask, so nothing runs. */
export const noApprover: AskApproval = async () => ({ verdict: "unavailable", reason: "There is no user to ask from here." });
