/**
 * The server's clock, as seen from this browser.
 *
 * A chat list puts rows this browser made (the message just sent, the answer being streamed) next
 * to rows and items the server dated (history, a wake turn's message, the Assistant's cards), and
 * places them by time. Dating the browser's own rows with the browser's clock mixes two clocks: a
 * phone running fifteen seconds fast put a card made mid-answer above the message just sent. So
 * every row the browser makes is dated with `serverNowIso()`.
 *
 * The offset is learned from `serverTime` on the chat socket's `session_state` and
 * `message_accepted`. A sample is the receive time minus the server's send time, i.e. the clock
 * difference plus that message's one-way latency, so the smallest of the recent samples is the
 * closest to the difference itself. Until a sample arrives the offset is 0: the browser's clock,
 * which is what every row used before.
 */

const MAX_SAMPLES = 8;
/** A sample this far from the others is a clock that was just set, not latency: start over. */
const RESET_JUMP_MS = 5 * 60_000;

let samples: number[] = [];
let offsetMs = 0;

/** Records one server timestamp received now (or at `receivedAt`, the browser's clock). */
export function noteServerTime(serverTime: unknown, receivedAt: number = Date.now()): void {
  if (typeof serverTime !== "number" || !Number.isFinite(serverTime) || serverTime <= 0) return;
  const sample = receivedAt - serverTime;
  if (samples.length > 0 && Math.abs(sample - offsetMs) > RESET_JUMP_MS) samples = [];
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.shift();
  offsetMs = Math.min(...samples);
}

/** How far this browser's clock runs ahead of the server's, in ms (negative: behind). */
export function serverClockOffset(): number {
  return offsetMs;
}

/** Now, on the server's clock (epoch ms). */
export function serverNow(): number {
  return Date.now() - offsetMs;
}

/** Now, on the server's clock, as the ISO string a message's `timestamp` holds. */
export function serverNowIso(): string {
  return new Date(serverNow()).toISOString();
}

/** For tests: forget every sample. */
export function resetServerClock(): void {
  samples = [];
  offsetMs = 0;
}
