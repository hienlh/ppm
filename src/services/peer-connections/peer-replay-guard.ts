/**
 * Sequence decisions for ordered envelopes, kept pure so every case is testable without a
 * database or a network.
 *
 * Rules (per connection, per direction):
 * - The sender has one message in flight; the next waits. Each message's sequence number and its
 *   exact sealed bytes are stored in the same transaction, before the first send, so a resend is
 *   always the same bytes.
 * - The receiver takes `seq = recv_seq + 1`. A `seq` it already stored, with the same bytes, is a
 *   resend after a lost answer: success, not an error. Anything ahead of `recv_seq + 1` gets a
 *   signed `nack {expected_seq}` (a gap); a number it holds with other bytes gets a `nack` naming
 *   that number and the signature it holds (a conflict). It never skips a gap on its own.
 * - Acks and nacks name the envelope they are about by its signature, because an old one can be
 *   replayed — by a relay, or by re-reading a mailbox after a restore — and must then change
 *   nothing. The sender renumbers only on proof that its own envelope at a number differs from
 *   the receiver's; otherwise it resends what it still holds, and declares gone (`resync`) what
 *   it no longer holds.
 */

/** A renumbering further than this is refused: no real restore loses a million messages. */
export const MAX_SEQ_JUMP = 1_000_000;

export type IncomingDecision =
  | { action: "accept" }
  /** Already stored with these exact bytes: acknowledge again, deliver nothing. */
  | { action: "duplicate" }
  | { action: "nack"; expectedSeq: number; conflict?: { seq: number; sig?: string } };

/**
 * What to do with an authenticated ordered envelope.
 * @param stored For a `seq` at or below `recv_seq`: the signature of the copy kept at that
 *   number, or null when no copy is kept any more.
 */
export function classifyIncoming(recvSeq: number, seq: number, incomingSig: string, stored: { sig: string } | null): IncomingDecision {
  if (seq === recvSeq + 1) return { action: "accept" };
  if (seq > recvSeq + 1) return { action: "nack", expectedSeq: recvSeq + 1 };
  if (stored && stored.sig === incomingSig) return { action: "duplicate" };
  // Another envelope under a number already taken: the sender's numbering went back.
  return { action: "nack", expectedSeq: recvSeq + 1, conflict: stored ? { seq, sig: stored.sig } : { seq } };
}

export interface NackFacts {
  expectedSeq: number;
  /** The highest number this side has assigned. */
  sendSeq: number;
  /** The smallest `s` such that every number `s..sendSeq` still has its sealed envelope here
   *  (`sendSeq + 1` when the newest is not held). */
  heldFrom: number;
  /**
   * For a conflict nack: true when this side holds an envelope at the conflicting number and its
   * signature differs from the receiver's (or the receiver kept none). False when it holds none
   * there or holds the very same one — a stale nack. Null for a gap nack.
   */
  conflictIsOurs: boolean | null;
}

export type NackPlan =
  /** Resend the stored envelopes `from..to` in order (all still held). */
  | { action: "resend"; from: number; to: number }
  /**
   * Part of `expectedSeq..` is no longer held: send `resync {next_seq}`, then resend
   * `nextSeq..to` (empty when `nextSeq > to`). `lost` messages are gone for good.
   */
  | { action: "resync"; nextSeq: number; to: number; lost: number }
  /**
   * This side's numbering went back. Set `send_seq = newSendSeq` and reseal whatever is in
   * flight after it. `unknown` messages the receiver holds were sent by a state this side no
   * longer remembers.
   */
  | { action: "jump"; newSendSeq: number; unknown: number }
  /** Nothing to do: a stale, replayed or impossible nack. */
  | { action: "ignore" };

/** The sender's answer to `nack`. */
export function planAfterNack(f: NackFacts): NackPlan {
  const { expectedSeq, sendSeq, heldFrom } = f;
  if (!Number.isSafeInteger(expectedSeq) || expectedSeq < 1) return { action: "ignore" };
  if (f.conflictIsOurs !== null) {
    if (!f.conflictIsOurs || expectedSeq - sendSeq > MAX_SEQ_JUMP) return { action: "ignore" };
    return { action: "jump", newSendSeq: Math.max(sendSeq, expectedSeq - 1), unknown: Math.max(0, expectedSeq - 1 - sendSeq) };
  }
  // A gap: the receiver lacks numbers this side assigned. One past what was assigned is no gap.
  if (expectedSeq > sendSeq) return { action: "ignore" };
  if (heldFrom <= expectedSeq) return { action: "resend", from: expectedSeq, to: sendSeq };
  return { action: "resync", nextSeq: heldFrom, to: sendSeq, lost: heldFrom - expectedSeq };
}

export type ResyncDecision = { action: "advance"; newRecvSeq: number; lost: number } | { action: "ignore" };

/** The receiver's answer to `resync {next_seq}`: move forward only, never back. */
export function applyResync(recvSeq: number, nextSeq: number): ResyncDecision {
  if (!Number.isSafeInteger(nextSeq) || nextSeq <= recvSeq + 1) return { action: "ignore" };
  return { action: "advance", newRecvSeq: nextSeq - 1, lost: nextSeq - 1 - recvSeq };
}
