/**
 * The transports this PPM can use, by kind. Each transport adds one `registerPeerTransport` call
 * where it is wired up; nothing else needs to know which transports exist.
 */
import type { PeerTransportKind } from "../../shared/peer-connections.ts";
import type { PeerTransport } from "./peer-transport.ts";

const transports = new Map<PeerTransportKind, PeerTransport>();

export function registerPeerTransport(transport: PeerTransport): void {
  if (transports.has(transport.kind)) throw new Error(`a ${transport.kind} transport is already registered`);
  transports.set(transport.kind, transport);
}

export function getPeerTransport(kind: PeerTransportKind): PeerTransport | null {
  return transports.get(kind) ?? null;
}

export function listPeerTransports(): PeerTransport[] {
  return [...transports.values()];
}

/** Remove every transport (tests, and shutdown after each has been stopped). */
export function clearPeerTransports(): void {
  transports.clear();
}
