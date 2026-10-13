/**
 * A script's log: every line it prints, masked and cut to size, kept twice — in a ring the UI
 * reads live (per schedule, across restarts of an always-on child), and in the bounded output
 * of the run record.
 */
import { BoundedBuffer } from "../bounded-buffer.ts";

export const MAX_LINE_CHARS = 4096;
const RING_SIZE = 1000;

export interface LogLine { seq: number; at: string; text: string }

export class LogRing {
  private lines: LogLine[] = [];
  private seq = 0;

  push(text: string): void {
    this.lines.push({ seq: ++this.seq, at: new Date().toISOString(), text });
    if (this.lines.length > RING_SIZE) this.lines.splice(0, this.lines.length - RING_SIZE);
  }

  /** The number of the last line pushed; it starts again from 0 when the server does. */
  get last(): number {
    return this.seq;
  }

  /** Lines after `seq` (all of those still held when `seq` is 0). */
  since(seq = 0): LogLine[] {
    return this.lines.filter((l) => l.seq > seq);
  }
}

const rings = new Map<number, LogRing>();

export function logRing(scheduleId: number): LogRing {
  let ring = rings.get(scheduleId);
  if (!ring) rings.set(scheduleId, (ring = new LogRing()));
  return ring;
}

export function dropLogRing(scheduleId: number): void {
  rings.delete(scheduleId);
}

/** One run's log: what it prints goes to the schedule's ring and to this run's output. */
export class RunLog {
  readonly output = new BoundedBuffer();
  lines = 0;

  constructor(private ring: LogRing, private mask: (text: string) => string) {}

  /** Masked before it is cut, so a cut can never leave half a secret showing. */
  push(raw: string): void {
    const masked = this.mask(raw);
    const text = masked.length > MAX_LINE_CHARS ? `${masked.slice(0, MAX_LINE_CHARS)} … [line cut]` : masked;
    this.lines++;
    this.output.append(`${text}\n`);
    this.ring.push(text);
  }
}

/** Calls `onLine` for each line of a byte stream, the last one included even without a newline. */
export async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let rest = "";
  for (;;) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    rest += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = rest.indexOf("\n")) >= 0) {
      onLine(rest.slice(0, nl).replace(/\r$/, ""));
      rest = rest.slice(nl + 1);
    }
  }
  rest += decoder.decode();
  if (rest) onLine(rest.replace(/\r$/, ""));
}
