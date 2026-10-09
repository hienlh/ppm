import { createDeviceBroker } from "../tab-tools-mcp/tab-open-broker.ts";
import type { ApprovalSummary, EndpointApprovalRequest } from "../../shared/assistant-approval.ts";

/**
 * Approvals the PPM Assistant's tool endpoint asks for before it changes anything, the same way
 * for Claude and Codex: the tool call puts a card on the Assistant session (`ws/chat.ts` holds it
 * as the session's pending approval, shows it on every device showing the session, and sends a
 * notification), then waits — its HTTP call held open — for the first device to answer.
 *
 * A call ends one of five ways, and only `approved` runs anything:
 *  - approved / denied: a device answered;
 *  - timeout: nobody answered within {@link approvalTimeoutMs} (ten minutes by default);
 *  - withdrawn: the agent's HTTP call closed, the user stopped the turn or typed a message
 *    instead, or the turn ended;
 *  - unavailable: the card could not be shown at all (no such session, too many waiting).
 *
 * Built on the device broker, so a session is known by the id it goes by now (Codex renames a
 * new chat during its first turn) and an answer counts only from the session it was asked in.
 */

export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;
export const APPROVAL_TIMEOUT_ENV = "PPM_ASSISTANT_APPROVAL_TIMEOUT_MS";
export const MAX_APPROVALS_IN_FLIGHT_PER_SESSION = 4;
export const MAX_APPROVALS_PER_MINUTE = 20;

/**
 * How long an approval waits. The environment may shorten it — tests and e2e fixtures cannot
 * wait ten minutes — but never lengthen it past the providers' own tool timeout.
 */
export function approvalTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[APPROVAL_TIMEOUT_ENV]);
  return Number.isInteger(raw) && raw >= 100 && raw <= DEFAULT_APPROVAL_TIMEOUT_MS ? raw : DEFAULT_APPROVAL_TIMEOUT_MS;
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

/** Puts the card on the session; 1 when the session exists to hold it, 0 otherwise. */
export type ApprovalDelivery = (sessionId: string, request: EndpointApprovalRequest) => number;
/** Told when a shown card's request ends, however it ended, so the card can go. */
export type ApprovalEnded = (sessionId: string, requestId: string, approved: boolean) => void;

export const DENIED_MESSAGE = "The user declined. Nothing was done; do not try again or reach the same result another way unless the user asks.";

export function createApprovalBroker(opts: {
  deliver: ApprovalDelivery;
  onEnd?: ApprovalEnded;
  canonical?: (sessionId: string) => string;
  now?: () => number;
  timeoutMs?: () => number;
}) {
  const timeoutMs = opts.timeoutMs ?? (() => approvalTimeoutMs());
  const inner = createDeviceBroker<EndpointApprovalRequest, ApprovalAnswer, ApprovalAsk>({
    deliver: opts.deliver,
    build: (requestId, ask) => ({
      type: "approval_request", requestId, tool: ask.tool, input: ask.input, summary: ask.summary, origin: "endpoint",
    }),
    messages: {
      noDevice: "The approval card could not be shown: this Assistant session is not running in PPM. Nothing was done.",
      busy: "Too many approvals are already waiting in this session; wait for the user to answer them. Nothing was done.",
      rateLimited: (perMinute) => `Approval was asked ${perMinute} times in the last minute; wait before asking again. Nothing was done.`,
      timeout: (seconds) => `The user did not answer within ${seconds >= 60 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`}. `
        + "Nothing was done; do not ask again unless the user asks.",
      withdrawn: "The request was withdrawn before the user answered. Nothing was done.",
    },
    logTag: "assistant-approval",
    onEnd: (sessionId, requestId, outcome) => opts.onEnd?.(sessionId, requestId, outcome.ok && outcome.result.approved),
    canonical: opts.canonical,
    now: opts.now,
    maxPending: 64,
    maxInFlightPerSession: MAX_APPROVALS_IN_FLIGHT_PER_SESSION,
    perMinute: MAX_APPROVALS_PER_MINUTE,
  });

  /** Asks the session's user; resolves once they answer or the request ends without an answer. */
  async function request(sessionId: string, ask: ApprovalAsk, signal?: AbortSignal): Promise<ApprovalVerdict> {
    const outcome = await inner.request(sessionId, ask, timeoutMs(), signal);
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
