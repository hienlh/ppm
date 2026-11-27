/**
 * Sequence decisions for ordered envelopes, kept pure so every case is testable without a
 * database or a network.
 *
 * Rules (per connection, per direction):
 * - The sender has one message in flight; the next waits. Each message's sequence number and its
 *   exact sealed bytes are stored in the same transaction, before the first send, so a resend is
 *   always the same bytes.
 * - The receiver takes `seq = recv_seq + 1`. A `seq` it already stored, with the same bytes, is a
 *   resend after a lost answer: success, not an error. Anything ahead of `recv_seq + 1`, or a
 *   number it holds with different bytes, gets a signed `nack {expected_seq}`; it never skips a
 *   gap on its own.
 * - The sender answers a `nack` by resending what it still holds; what it no longer holds it
 *   declares gone with `resync {next_seq}`, and the receiver moves past the gap and says so.
 */

export type IncomingDecision =
  | { action: "accept" }
  /** Already stored with these exact bytes: acknowledge again, deliver nothing. */
  | { action: "duplicate" }
  | { action: "nack"; expectedSeq: number; reason: "gap" | "conflict" };

/**
 * What to do with an authenticated ordered envelope.
 * @param storedSame For a `seq` at or below `recv_seq`: true when the stored copy is these bytes,
 *   false when it differs, null when no copy is kept any more.
 */
export function classifyIncoming(recvSeq: number, seq: number, storedSame: boolean | null): IncomingDecision {
  if (seq === recvSeq + 1) return { action: "accept" };
  if (seq > recvSeq + 1) return { action: "nack", expectedSeq: recvSeq + 1, reason: "gap" };
  // seq <= recvSeq. The same bytes are a resend; different bytes (or none to compare with) mean the
  // sender's numbering went back — a restored database — and it must move forward.
  if (storedSame === true) return { action: "duplicate" };
  return { action: "nack", expectedSeq: recvSeq + 1, reason: "conflict" };
}

export type NackPlan =
  /** Resend the stored envelopes `from..to` in order (all still held). */
  | { action: "resend"; from: number; to: number }
  /**
   * Some of `expectedSeq..` is no longer held: send `resync {next_seq}`, then resend `nextSeq..to`
   * (empty when `nextSeq > to`). `lost` messages are gone for good.
   */
  | { action: "resync"; nextSeq: number; to: number; lost: number }
  /**
   * The receiver is ahead of this side's numbering (this side's database went back). Renumber
   * from `expectedSeq`: `send_seq = expectedSeq - 1`, and reseal whatever was in flight. `unknown`
   * messages the receiver holds were sent by a state this side no longer remembers.
   */
  | { action: "jump"; newSendSeq: number; unknown: number }
  /** Nothing to do (a stale or repeated nack). */
  | { action: "ignore" };

/**
 * The sender's answer to `nack {expected_seq}`.
 * @param sendSeq The highest sequence number this side has assigned.
 * @param oldestHeld The lowest sequence number whose sealed envelope is still stored, or null.
 * @param inFlightSeq The number of the message waiting for an answer, or null.
 */
export function planAfterNack(expectedSeq: number, sendSeq: number, oldestHeld: number | null, inFlightSeq: number | null): NackPlan {
  if (!Number.isSafeInteger(expectedSeq) || expectedSeq < 1) return { action: "ignore" };
  if (expectedSeq > sendSeq + 1) return { action: "jump", newSendSeq: expectedSeq - 1, unknown: expectedSeq - 1 - sendSeq };
  if (expectedSeq === sendSeq + 1) {
    // The receiver has everything assigned so far. If something was in flight under a number it
    // already holds with different bytes, this side went back: renumber what is in flight.
    return inFlightSeq !== null && inFlightSeq < expectedSeq
      ? { action: "jump", newSendSeq: sendSeq, unknown: 0 }
      : { action: "ignore" };
  }
  if (oldestHeld !== null && oldestHeld <= expectedSeq) return { action: "resend", from: expectedSeq, to: sendSeq };
  const nextSeq = oldestHeld ?? sendSeq + 1;
  return { action: "resync", nextSeq, to: sendSeq, lost: nextSeq - expectedSeq };
}

export type ResyncDecision = { action: "advance"; newRecvSeq: number; lost: number } | { action: "ignore" };

/** The receiver's answer to `resync {next_seq}`: move forward only, never back. */
export function applyResync(recvSeq: number, nextSeq: number): ResyncDecision {
  if (!Number.isSafeInteger(nextSeq) || nextSeq <= recvSeq + 1) return { action: "ignore" };
  return { action: "advance", newRecvSeq: nextSeq - 1, lost: nextSeq - 1 - recvSeq };
}
