/**
 * Ticket → loopback WHEP endpoint, so the browser can negotiate WebRTC without the relay ever
 * being reachable from outside this host.
 *
 * The rule this exists to enforce: **the client never names an upstream.** It presents a
 * ticket PPM minted and handed it over the already-authenticated WebSocket, and the proxy
 * looks the URL up here. A route that forwarded a client-supplied URL instead would be an
 * open SSRF hole in a feature that already requires host control to reach.
 *
 * A ticket lives exactly as long as its session: registered when the relay comes up, dropped
 * when the session closes, so a captured ticket stops working the moment the viewer does.
 */
import { randomBytes } from "node:crypto";

const tickets = new Map<string, string>();

/** Register a session's relay and return the ticket the client should present. */
export function registerWhepTarget(loopbackWhepUrl: string): string {
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, loopbackWhepUrl);
  return ticket;
}

/** The endpoint a ticket stands for, or null when it is unknown or already released. */
export function resolveWhepTarget(ticket: string): string | null {
  return tickets.get(ticket) ?? null;
}

export function releaseWhepTicket(ticket: string): void {
  tickets.delete(ticket);
}

/** Test seam. */
export function clearWhepTickets(): void {
  tickets.clear();
}
