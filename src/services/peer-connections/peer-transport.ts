/**
 * What every way of carrying envelopes between two PPMs provides. A transport moves sealed
 * envelopes and nothing else: it never sees a key, a body or a session, and it never decides
 * whether a message is accepted (`peer-inbox-db.ts` does). The relay and Tailscale transports
 * each implement this and register themselves in `peer-transport-registry.ts`.
 */
import type { PeerTransportKind } from "../../shared/peer-connections.ts";
import type { PeerEnvelope } from "../../shared/peer-envelope.ts";
import type { PeerConnectionRow } from "./peer-connections-db.ts";

export type PeerSendResult = "delivered" | "queued" | { error: string };

export interface PeerTransport {
  kind: PeerTransportKind;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Hand one envelope to the other side. `delivered`: the other PPM has it. `queued`: a relay
   * holds it for the other PPM. Never throws for a network failure; that is an `{ error }`.
   */
  send(conn: PeerConnectionRow, env: PeerEnvelope): Promise<PeerSendResult>;
  /**
   * Register the one handler for envelopes that arrive. The transport acknowledges an envelope to
   * its carrier (the relay) only after the handler has resolved, and acknowledges malformed or
   * unknown ones too, after logging, so a single bad envelope cannot block a mailbox.
   */
  onEnvelope(handler: (connTag: string, env: PeerEnvelope) => Promise<void>): void;
  health(conn: PeerConnectionRow): Promise<{ online: boolean; since?: number }>;
}
