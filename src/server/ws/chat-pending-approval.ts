import type { ApprovalSummary } from "../../shared/assistant-approval.ts";

/**
 * The approval card a chat session is waiting on, one at a time.
 *
 * Two sources ask: the session's provider (Claude's canUseTool, Codex's command and patch
 * approvals) and, in a PPM Assistant session, the Assistant's tool endpoint. Both land on the
 * same single card the chat shows, so they queue behind each other instead of overwriting: a
 * card replaced by a newer one could never be answered, and its tool call would wait forever.
 *
 * Every way a card leaves goes through {@link PendingApprovals.clear}/{@link PendingApprovals.clearAll},
 * which finish the request on the side that is waiting for it: a provider's request is refused
 * when told to (so its blocked tool call returns), an endpoint request ends with the reason
 * (so its HTTP call answers "not run"). When the shown card leaves, the next one is shown.
 */

export interface PendingApprovalEvent {
  type: "approval_request";
  requestId: string;
  tool: string;
  input: unknown;
  /** Present on an endpoint card: what will happen, built by the server. */
  summary?: ApprovalSummary;
  /** "endpoint" for a request the Assistant's tool endpoint holds; absent for the provider's own. */
  origin?: "endpoint";
}

/** Where a session keeps its cards: the one shown and those queued behind it. */
export interface ApprovalSlot {
  pendingApprovalEvent?: PendingApprovalEvent;
  approvalQueue?: PendingApprovalEvent[];
}

/** Why a card went: `code` for the trace, `message` for the agent whose request it was. */
export interface ApprovalEndReason {
  code: string;
  message: string;
}

export interface ClearHow {
  /** Refuse a provider's request, so its blocked tool call returns. Endpoint requests always end. */
  deny?: boolean;
  /** Tell every device the provider's card is gone. An endpoint card is always announced. */
  announce?: boolean;
  /** Only cards from this source. */
  only?: "provider" | "endpoint";
  /** The answer carried by the announcement, when a device answered. */
  approved?: boolean;
  answers?: unknown;
}

export interface PendingApprovalOps {
  /** Puts a card in front of every device showing the session and sends its notification. */
  show(sessionId: string, event: PendingApprovalEvent): void;
  /** Tells every device showing the session that a card is gone. */
  announceResolved(sessionId: string, requestId: string, approved: boolean, answers: unknown): void;
  /** Refuses a provider's request. */
  denyProvider(sessionId: string, requestId: string, reason: ApprovalEndReason): void;
  /** Ends an endpoint request without running what it asked for; a no-op once it has ended. */
  endEndpoint(requestId: string, reason: ApprovalEndReason): void;
}

export const isEndpointApproval = (event: PendingApprovalEvent): boolean => event.origin === "endpoint";

export function createPendingApprovals(ops: PendingApprovalOps) {
  const all = (slot: ApprovalSlot): PendingApprovalEvent[] =>
    [...(slot.pendingApprovalEvent ? [slot.pendingApprovalEvent] : []), ...(slot.approvalQueue ?? [])];

  function has(slot: ApprovalSlot, requestId: string): boolean {
    return all(slot).some((e) => e.requestId === requestId);
  }

  /** Shows `event` now when nothing is shown, otherwise queues it behind what is. */
  function offer(sessionId: string, slot: ApprovalSlot, event: PendingApprovalEvent): "shown" | "queued" | "duplicate" {
    if (has(slot, event.requestId)) return "duplicate";
    if (!slot.pendingApprovalEvent) {
      slot.pendingApprovalEvent = event;
      ops.show(sessionId, event);
      return "shown";
    }
    (slot.approvalQueue ??= []).push(event);
    return "queued";
  }

  function promote(sessionId: string, slot: ApprovalSlot): void {
    if (slot.pendingApprovalEvent) return;
    const next = slot.approvalQueue?.shift();
    if (!next) return;
    slot.pendingApprovalEvent = next;
    ops.show(sessionId, next);
  }

  function finish(sessionId: string, event: PendingApprovalEvent, reason: ApprovalEndReason, how: ClearHow): void {
    const endpoint = isEndpointApproval(event);
    if (endpoint) ops.endEndpoint(event.requestId, reason);
    else if (how.deny) ops.denyProvider(sessionId, event.requestId, reason);
    if (endpoint || how.announce) ops.announceResolved(sessionId, event.requestId, how.approved ?? false, how.answers ?? null);
  }

  /** Removes one card; false when the session holds no card with that id. */
  function clear(sessionId: string, slot: ApprovalSlot, requestId: string, reason: ApprovalEndReason, how: ClearHow = {}): boolean {
    let event: PendingApprovalEvent | undefined;
    if (slot.pendingApprovalEvent?.requestId === requestId) {
      event = slot.pendingApprovalEvent;
      slot.pendingApprovalEvent = undefined;
    } else {
      const at = slot.approvalQueue?.findIndex((e) => e.requestId === requestId) ?? -1;
      if (at < 0) return false;
      event = slot.approvalQueue!.splice(at, 1)[0]!;
    }
    finish(sessionId, event, reason, how);
    promote(sessionId, slot);
    return true;
  }

  /** Removes every card (or every card of one source), shown and queued. */
  function clearAll(sessionId: string, slot: ApprovalSlot, reason: ApprovalEndReason, how: ClearHow = {}): void {
    const matches = (e: PendingApprovalEvent) => !how.only || (how.only === "endpoint") === isEndpointApproval(e);
    const going = all(slot).filter(matches);
    if (going.length === 0) return;
    if (slot.pendingApprovalEvent && matches(slot.pendingApprovalEvent)) slot.pendingApprovalEvent = undefined;
    slot.approvalQueue = (slot.approvalQueue ?? []).filter((e) => !matches(e));
    for (const event of going) finish(sessionId, event, reason, how);
    promote(sessionId, slot);
  }

  return { offer, has, clear, clearAll };
}

export type PendingApprovals = ReturnType<typeof createPendingApprovals>;

/** The reasons a card goes without being answered, worded for the agent that asked. */
export const APPROVAL_END = {
  answered: { code: "answered", message: "The user answered." },
  turnStarted: { code: "turn_started", message: "A new turn started before the user answered; not run." },
  turnEnded: { code: "turn_ended", message: "The turn ended before the user answered; not run." },
  superseded: { code: "superseded_by_message", message: "The user sent another message instead of answering; not run." },
  cancelled: { code: "ws_cancel", message: "The user stopped the turn; not run." },
} satisfies Record<string, ApprovalEndReason>;
