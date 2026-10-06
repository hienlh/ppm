/**
 * What the Logs reader keeps per record, as typed columns instead of objects: everything a
 * filter needs (time, level, area, tag, chat) without the text, which stays in the file and is
 * read back a page at a time. `ppm.log` and its three rotated copies hold ~450k records; as
 * objects that was ~200 MB of heap, as columns it is ~13 MB.
 */
import { LOG_LEVELS, type LogLevel } from "../../shared/log-levels.ts";
import { LOG_SOURCE_IDS, type LogSourceId } from "../../shared/logs-model.ts";

/** Tags and chat ids are interned once per process, so a record holds a small number. */
class Interner {
  private readonly ids = new Map<string, number>();
  readonly values: string[] = [];
  id(value: string): number {
    let id = this.ids.get(value);
    if (id === undefined) {
      id = this.values.length;
      this.values.push(value);
      this.ids.set(value, id);
    }
    return id;
  }
  find(value: string): number | undefined {
    return this.ids.get(value);
  }
}

export const tagTable = new Interner();
export const sidTable = new Interner();

export const LEVEL_INDEX: Readonly<Record<LogLevel, number>> = Object.fromEntries(LOG_LEVELS.map((l, i) => [l, i])) as Record<LogLevel, number>;
export const SOURCE_INDEX: Readonly<Record<LogSourceId, number>> = Object.fromEntries(LOG_SOURCE_IDS.map((s, i) => [s, i])) as Record<LogSourceId, number>;

/** A record that starts PPM again; the viewer draws a divider before it. */
export const FLAG_RESTART = 1;

export class RecordColumns {
  count = 0;
  ts = new Float64Array(256);
  lv = new Uint8Array(256);
  src = new Uint8Array(256);
  tag = new Uint32Array(256);
  /** Index into `sidTable`, or -1. */
  sid = new Int32Array(256);
  flags = new Uint8Array(256);
  /**
   * The time a record is placed and ranged by: its own stamp, unless that stamp is out of step
   * with the lines written around it, when it takes the time of the last line before it that is
   * in step. File order is the order things happened; a stamp is only a claim about it. A test
   * running on a fake clock once wrote lines stamped six hours ahead into a real `ppm.log`, and
   * going by stamps alone that one line carried the rest of its file past six hours of other
   * lines, and a time range could start at it. In step means on the longest run of records whose
   * stamps never go back. Read it through `ensureOrder()`.
   */
  order = new Float64Array(256);
  /** Records whose `order` is settled. */
  private ordered = 0;

  push(ts: number, lv: LogLevel, src: LogSourceId, tag: string, sid: string | undefined, flags = 0): number {
    if (this.count === this.ts.length) this.grow();
    const i = this.count++;
    // Appending in step, which is nearly always, settles the new record at once.
    if (this.ordered >= i) {
      if (ts === ts && (i === 0 || ts >= this.order[i - 1]!)) {
        this.order[i] = ts;
        this.ordered = i + 1;
      } else {
        this.ordered = i;
      }
    }
    this.ts[i] = ts;
    this.lv[i] = LEVEL_INDEX[lv];
    this.src[i] = SOURCE_INDEX[src];
    this.tag[i] = tagTable.id(tag);
    this.sid[i] = sid ? sidTable.id(sid) : -1;
    this.flags[i] = flags;
    return i;
  }

  level(i: number): LogLevel {
    return LOG_LEVELS[this.lv[i]!]!;
  }

  source(i: number): LogSourceId {
    return LOG_SOURCE_IDS[this.src[i]!]!;
  }

  tagName(i: number): string {
    return tagTable.values[this.tag[i]!]!;
  }

  sessionId(i: number): string | undefined {
    const s = this.sid[i]!;
    return s < 0 ? undefined : sidTable.values[s];
  }

  /** First record whose `order` is at or after `ts`. */
  lowerBound(ts: number): number {
    this.ensureOrder();
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.order[mid]! < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Settles `order` for every record, after a record came in out of step or a stamp was set late. */
  ensureOrder(): void {
    const n = this.count;
    if (this.ordered === n) return;
    const ts = this.ts;
    // Patience sorting: the longest run of records whose stamps never go back.
    const tails = new Int32Array(n);
    const prev = new Int32Array(n).fill(-1);
    let len = 0;
    for (let i = 0; i < n; i++) {
      const t = ts[i]!;
      if (t !== t) continue; // no time known: never in step
      let lo = 0;
      let hi = len;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (ts[tails[mid]!]! <= t) lo = mid + 1;
        else hi = mid;
      }
      prev[i] = lo > 0 ? tails[lo - 1]! : -1;
      tails[lo] = i;
      if (lo === len) len++;
    }
    const inStep = new Uint8Array(n);
    for (let i = len > 0 ? tails[len - 1]! : -1; i >= 0; i = prev[i]!) inStep[i] = 1;
    let first = 0;
    while (first < n && !inStep[first]) first++;
    let at = first < n ? ts[first]! : Number.NaN;
    for (let i = 0; i < n; i++) {
      if (inStep[i]) at = ts[i]!;
      this.order[i] = at;
    }
    this.ordered = n;
  }

  protected grow(): void {
    const n = this.ts.length * 2;
    this.ts = copyInto(new Float64Array(n), this.ts);
    this.lv = copyInto(new Uint8Array(n), this.lv);
    this.src = copyInto(new Uint8Array(n), this.src);
    this.tag = copyInto(new Uint32Array(n), this.tag);
    this.sid = copyInto(new Int32Array(n), this.sid);
    this.flags = copyInto(new Uint8Array(n), this.flags);
    this.order = copyInto(new Float64Array(n), this.order);
  }
}

export function copyInto<T extends Float64Array | Uint32Array | Int32Array | Uint8Array>(to: T, from: T): T {
  to.set(from as never);
  return to;
}
