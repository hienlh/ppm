/**
 * The slice of a `/ws/global` socket the hub needs. `send` returns a number on
 * a real Bun `ServerWebSocket` (-1 backpressure, 0 dropped, >0 bytes sent) —
 * the hub checks it after every push and drops the socket's subscriptions on
 * 0 or a throw, never on -1 (that just means try again later).
 */
export interface AgentTranscriptWsLike {
  send(data: string): number;
  data?: { token?: string | null };
}

/** Send one JSON message; false on a dropped send (0) or a throw — never on backpressure (-1). */
export function sendWsMessage(ws: AgentTranscriptWsLike, payload: unknown): boolean {
  try {
    return ws.send(JSON.stringify(payload)) !== 0;
  } catch {
    return false;
  }
}
