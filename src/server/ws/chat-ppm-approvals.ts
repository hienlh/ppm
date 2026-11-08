import { dbApprovalBroker } from "../../services/db-ai-tools/db-approval-broker.ts";
import { collabApprovalBroker } from "../../services/session-collab/collab-approval-broker.ts";

/**
 * PPM's own approvals, as the chat's one approval slot sees them: a `db_execute` change and the
 * session tools' cards (create, pair limit, escalation). Each is answered over authenticated HTTP,
 * never over the chat socket, and waits behind a provider's own approval rather than replacing it.
 * The slot code in `ws/chat.ts` treats them alike through this one object, so a new kind needs
 * only its broker added here.
 */

interface PpmApprovalBroker {
  has(requestId: string): boolean;
  pendingEvent(sessionId: string): { type: string; requestId: string; tool: string; input: unknown } | null;
  cancelSession(sessionId: string, message: string): boolean;
}

const brokers: readonly PpmApprovalBroker[] = [dbApprovalBroker, collabApprovalBroker];

export const ppmApprovals = {
  /** Whether `requestId` is one of PPM's own approvals, still pending. */
  has: (requestId: string): boolean => brokers.some((b) => b.has(requestId)),
  /** The session's first PPM approval still waiting for the slot, or null. */
  pendingEvent(sessionId: string) {
    for (const b of brokers) {
      const event = b.pendingEvent(sessionId);
      if (event) return event;
    }
    return null;
  },
  /** Settles every PPM approval the session has as not allowed; true when there was one. */
  cancelSession(sessionId: string, message: string): boolean {
    let any = false;
    for (const b of brokers) any = b.cancelSession(sessionId, message) || any;
    return any;
  },
};
