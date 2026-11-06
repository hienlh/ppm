/**
 * What PPM remembers about sessions messaging each other, outside `ppm.db`:
 *
 * - per unordered pair of sessions, how many messages their AIs sent each other automatically
 *   since the user last wrote in either (`auto`), plus the extra messages the user allowed at the
 *   limit (`extra`) — the pair stays listed after a reset, which is how `linkedSessions` knows two
 *   sessions have talked;
 * - the sessions the user allowed to create sessions without asking;
 * - the sender → target pairs the user allowed to message a more permissive session.
 *
 * Held in memory and written, debounced and atomically, to `<ppm dir>/session-collab/pairs.json`.
 * Every id is canonical (`resolveMigratedSession`), so a Codex chat renamed during its first turn
 * keeps its counters; `renameSession` re-keys what was recorded under the old id.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMigratedSession } from "../db.service.ts";
import { getPpmDir } from "../ppm-dir.ts";
import { createLogger } from "../logger.ts";
import { SESSION_ID_RE } from "../../shared/session-turn-ids.ts";

const log = createLogger("session-collab");

/** Pairs kept at most; the longest-quiet go first. */
const MAX_PAIRS = 5_000;
const MAX_FLAGS = 5_000;
const WRITE_DEBOUNCE_MS = 500;

interface PairState {
  auto: number;
  extra: number;
  /** Epoch ms of the last automatic message. */
  lastAt: number;
}

interface SidecarFile {
  version: 1;
  pairs: Record<string, PairState>;
  allowCreate: string[];
  allowEscalation: string[];
}

const sidecarPath = (): string => join(getPpmDir(), "session-collab", "pairs.json");
const canonical = (id: string): string => resolveMigratedSession(id);
const pairKey = (a: string, b: string): string => (a < b ? `${a} ${b}` : `${b} ${a}`);
const escalationKey = (sender: string, target: string): string => `${sender}>${target}`;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

class PairCounter {
  private pairs = new Map<string, PairState>();
  private allowCreate = new Set<string>();
  private allowEscalation = new Set<string>();
  private loaded = false;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Messages sent automatically between the two since the user last wrote in either. */
  count(a: string, b: string): number {
    return this.pair(a, b)?.auto ?? 0;
  }

  /** Messages left before the user is asked, under `limit` plus whatever the user granted. */
  remaining(a: string, b: string, limit: number): number {
    const p = this.pair(a, b);
    return Math.max(0, limit + (p?.extra ?? 0) - (p?.auto ?? 0));
  }

  /** One automatic message between the two; returns the pair's new count. */
  record(a: string, b: string): number {
    const key = this.key(a, b);
    if (!key) return 0;
    const p = this.pairs.get(key) ?? { auto: 0, extra: 0, lastAt: 0 };
    p.auto += 1;
    p.lastAt = Date.now();
    this.pairs.delete(key); // newest last, so the cap drops the longest-quiet pairs
    this.pairs.set(key, p);
    this.trim();
    this.schedule();
    return p.auto;
  }

  /** The user allowed `n` more messages between the two. */
  grant(a: string, b: string, n: number): void {
    const key = this.key(a, b);
    if (!key || !(n > 0)) return;
    const p = this.pairs.get(key) ?? { auto: 0, extra: 0, lastAt: Date.now() };
    p.extra += Math.floor(n);
    this.pairs.set(key, p);
    this.schedule();
  }

  /** The user wrote in this session from a browser: every pair it is in starts counting again. */
  resetForSession(sessionId: string): void {
    this.load();
    const id = canonical(sessionId);
    let changed = false;
    for (const [key, p] of this.pairs) {
      if (!key.split(" ").includes(id) || (p.auto === 0 && p.extra === 0)) continue;
      p.auto = 0;
      p.extra = 0;
      changed = true;
    }
    if (changed) this.schedule();
  }

  /** Every session this one has exchanged automatic messages with. */
  messagedWith(sessionId: string): string[] {
    this.load();
    const id = canonical(sessionId);
    const out: string[] = [];
    for (const key of this.pairs.keys()) {
      const [a, b] = key.split(" ") as [string, string];
      if (a === id) out.push(b);
      else if (b === id) out.push(a);
    }
    return out;
  }

  /** "Allow for this session" on a create card. */
  setAllowCreate(sessionId: string): void {
    this.load();
    this.addFlag(this.allowCreate, canonical(sessionId));
  }

  canCreateWithoutAsking(sessionId: string): boolean {
    this.load();
    return this.allowCreate.has(canonical(sessionId));
  }

  /** "Allow for this session" on an escalation card: this sender may message this target. */
  setAllowEscalation(senderId: string, targetId: string): void {
    this.load();
    this.addFlag(this.allowEscalation, escalationKey(canonical(senderId), canonical(targetId)));
  }

  escalationAllowed(senderId: string, targetId: string): boolean {
    this.load();
    return this.allowEscalation.has(escalationKey(canonical(senderId), canonical(targetId)));
  }

  /** A provider renamed a session: what was recorded under the old id follows it. */
  renameSession(oldId: string, newId: string): void {
    this.load();
    if (oldId === newId || !this.rekey((id) => (id === oldId ? newId : id))) return;
    this.schedule();
  }

  /** The session was deleted: nothing about it is kept. */
  forgetSession(sessionId: string): void {
    this.load();
    const id = canonical(sessionId);
    let changed = false;
    for (const key of [...this.pairs.keys()]) {
      if (key.split(" ").includes(id)) { this.pairs.delete(key); changed = true; }
    }
    if (this.allowCreate.delete(id)) changed = true;
    for (const key of [...this.allowEscalation]) {
      if (key.split(">").includes(id)) { this.allowEscalation.delete(key); changed = true; }
    }
    if (changed) this.schedule();
  }

  /** Writes what is pending now (shutdown, tests). Never throws. */
  flush(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    if (!this.loaded) return;
    try {
      const path = sidecarPath();
      mkdirSync(join(getPpmDir(), "session-collab"), { recursive: true });
      const file: SidecarFile = {
        version: 1,
        pairs: Object.fromEntries(this.pairs),
        allowCreate: [...this.allowCreate],
        allowEscalation: [...this.allowEscalation],
      };
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (e) {
      log.warn(`could not save session pair counters: ${(e as Error).message}`);
    }
  }

  /** Forgets the in-memory state, so the next call reads the sidecar again. For tests. */
  reloadForTests(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    this.pairs.clear();
    this.allowCreate.clear();
    this.allowEscalation.clear();
    this.loaded = false;
  }

  private pair(a: string, b: string): PairState | undefined {
    const key = this.key(a, b);
    return key ? this.pairs.get(key) : undefined;
  }

  /** The pair's key by canonical ids, or null for a session paired with itself or a bad id. */
  private key(a: string, b: string): string | null {
    this.load();
    const ca = canonical(a);
    const cb = canonical(b);
    if (ca === cb || !SESSION_ID_RE.test(ca) || !SESSION_ID_RE.test(cb)) return null;
    return pairKey(ca, cb);
  }

  private addFlag(set: Set<string>, value: string): void {
    if (set.has(value)) return;
    set.add(value);
    if (set.size > MAX_FLAGS) set.delete(set.values().next().value!);
    this.schedule();
  }

  private trim(): void {
    while (this.pairs.size > MAX_PAIRS) this.pairs.delete(this.pairs.keys().next().value!);
  }

  /** Maps every id through `map`, merging pairs that land on one key. Whether anything moved. */
  private rekey(map: (id: string) => string): boolean {
    let moved = false;
    const pairs = new Map<string, PairState>();
    for (const [key, p] of this.pairs) {
      const [a, b] = key.split(" ").map(map) as [string, string];
      if (pairKey(a, b) !== key) moved = true;
      if (a === b) continue;
      const k = pairKey(a, b);
      const prev = pairs.get(k);
      pairs.set(k, prev ? { auto: prev.auto + p.auto, extra: prev.extra + p.extra, lastAt: Math.max(prev.lastAt, p.lastAt) } : p);
    }
    const create = new Set([...this.allowCreate].map(map));
    const escalation = new Set([...this.allowEscalation].map((k) => {
      const [s, t] = k.split(">") as [string, string];
      return escalationKey(map(s), map(t));
    }));
    if (create.size !== this.allowCreate.size || [...create].some((id) => !this.allowCreate.has(id))) moved = true;
    if (escalation.size !== this.allowEscalation.size || [...escalation].some((k) => !this.allowEscalation.has(k))) moved = true;
    this.pairs = pairs;
    this.allowCreate = create;
    this.allowEscalation = escalation;
    return moved;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const path = sidecarPath();
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SidecarFile>;
      if (raw.version !== 1) return;
      const sorted = Object.entries(raw.pairs ?? {})
        .filter(([key, p]) => {
          const ids = key.split(" ");
          return ids.length === 2 && ids.every((id) => SESSION_ID_RE.test(id))
            && !!p && isCount(p.auto) && isCount(p.extra) && isCount(p.lastAt);
        })
        .sort((x, y) => x[1].lastAt - y[1].lastAt);
      for (const [key, p] of sorted) this.pairs.set(key, { auto: p.auto, extra: p.extra, lastAt: p.lastAt });
      for (const id of Array.isArray(raw.allowCreate) ? raw.allowCreate : []) {
        if (typeof id === "string" && SESSION_ID_RE.test(id)) this.allowCreate.add(id);
      }
      for (const k of Array.isArray(raw.allowEscalation) ? raw.allowEscalation : []) {
        if (typeof k === "string" && k.split(">").length === 2 && k.split(">").every((id) => SESSION_ID_RE.test(id))) this.allowEscalation.add(k);
      }
      // Sessions renamed while the file sat on disk are followed to their current ids.
      if (this.rekey(canonical)) this.schedule();
      this.trim();
    } catch (e) {
      log.warn(`unreadable session pair counters, starting empty: ${(e as Error).message}`);
    }
  }

  private schedule(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => this.flush(), WRITE_DEBOUNCE_MS);
    (this.writeTimer as { unref?: () => void }).unref?.();
  }
}

export const pairCounter = new PairCounter();
