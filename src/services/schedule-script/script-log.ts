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

  constructor(private ring: LogRing, private mask: (text: string, cutAtEnd?: boolean) => string) {}

  /**
   * Masked before it is cut, so a cut can never leave half a secret showing. A line `readLines`
   * already `cut` can end partway through a secret, so the mask is told to hide that end too.
   */
  push(raw: string, cut = false): void {
    const masked = this.mask(raw, cut);
    const text = cut || masked.length > MAX_LINE_CHARS ? `${masked.slice(0, MAX_LINE_CHARS)} … [line cut]` : masked;
    this.lines++;
    this.output.append(`${text}\n`);
    this.ring.push(text);
  }
}

/**
 * The longest line kept from a script's output. Until its newline arrives a line is held in the
 * server, and a script can print forever without one. Far above what is shown (`MAX_LINE_CHARS`),
 * so masking still sees a secret whole unless the line is made of little else.
 */
export const MAX_READ_LINE_CHARS = 64 * 1024;

/**
 * Calls `onLine` for each line of a byte stream, the last one included even without a newline.
 * A line longer than `maxChars` is passed on as soon as it is that long, cut, with `cut` set, and
 * the rest of it is dropped up to its newline.
 */
export async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string, cut: boolean) => void,
  maxChars = MAX_READ_LINE_CHARS,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let rest = "";
  /** Inside a line already passed on cut: what follows, up to its newline, is dropped. */
  let dropping = false;
  const take = (text: string): void => {
    rest += text;
    for (;;) {
      const nl = rest.indexOf("\n");
      if (dropping) {
        if (nl < 0) {
          rest = "";
          return;
        }
        dropping = false;
        rest = rest.slice(nl + 1);
      } else if (nl > maxChars || (nl < 0 && rest.length > maxChars)) {
        onLine(rest.slice(0, maxChars), true);
        dropping = true;
        rest = rest.slice(maxChars);
      } else if (nl >= 0) {
        onLine(rest.slice(0, nl).replace(/\r$/, ""), false);
        rest = rest.slice(nl + 1);
      } else {
        return;
      }
    }
  };
  for (;;) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    take(decoder.decode(chunk, { stream: true }));
  }
  take(decoder.decode());
  if (rest) onLine(rest.replace(/\r$/, ""), false);
}
