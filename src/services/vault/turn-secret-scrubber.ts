/**
 * The values of the secure and sealed tiers that were just handed to an AI, kept per chat so that
 * what PPM itself writes elsewhere can keep them out: the session trace, the Assistant's notebook,
 * Telegram, a report or a message to another chat.
 *
 * A fallback, not a boundary. It matches a value as given and loosely (spaces dropped, case
 * ignored: `QQ 12 34 56 C` ~ `qq123456c`); an AI that spells a value out letter by letter or
 * translates it gets past it. What reached the provider is in its transcript whatever PPM does.
 *
 * Values are held for HOLD_MS after the last read in that chat — long enough to cover the rest of
 * the turn, its relay to Telegram, and a secure window — then forgotten. Public values are never
 * held: that tier is not protected.
 */

export const HOLD_MS = 24 * 60 * 60_000;
/**
 * Shorter values (a short PIN, a CVV) would match ordinary text, so the scrubber leaves them alone:
 * nothing but the vault's own rules keeps those out of PPM's other writes.
 */
const MIN_VALUE_CHARS = 4;

interface Held { name: string; pattern: RegExp; loose: string }
interface Entry { items: Held[]; until: number }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const loosen = (s: string) => s.replace(/\s+/g, "").toLowerCase();
/** The forms a value takes in text PPM sends on: as typed, and HTML-escaped (Telegram, push). */
const formsOf = (value: string): string[] => {
  const html = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return html === value ? [value] : [value, html];
};

function patternFor(value: string): RegExp {
  const chars = [...value.replace(/\s+/g, "")].map(escape);
  return new RegExp(chars.join("\\s*"), "gi");
}

export function createTurnSecretScrubber(opts: { now?: () => number; canonical?: (sessionId: string) => string } = {}) {
  const now = opts.now ?? Date.now;
  const canonical = opts.canonical ?? ((id: string) => id);
  const held = new Map<string, Entry>();

  function live(): [string, Entry][] {
    const t = now();
    for (const [id, e] of held) if (e.until <= t) held.delete(id);
    return [...held];
  }

  function entriesFor(sessionId?: string): Held[] {
    const all = live();
    if (sessionId === undefined) return all.flatMap(([, e]) => e.items);
    return held.get(canonical(sessionId))?.items ?? [];
  }

  return {
    /** Remembers values handed to the AI of `sessionId`. */
    hold(sessionId: string, items: readonly { name: string; value: string }[]): void {
      const id = canonical(sessionId);
      const entry = held.get(id) ?? { items: [], until: 0 };
      for (const { name, value } of items) {
        for (const form of formsOf(value)) {
          const loose = loosen(form);
          if (loose.length < MIN_VALUE_CHARS) continue;
          if (!entry.items.some((h) => h.loose === loose)) entry.items.push({ name, pattern: patternFor(form), loose });
        }
      }
      entry.until = now() + HOLD_MS;
      if (entry.items.length) held.set(id, entry);
    },

    /** `text` with every held value replaced by `[vault:<name>]`; every chat's when no session is named. */
    scrub(text: string, sessionId?: string): string {
      let out = text;
      // A function, so `$&` or `$1` in an item's name is never read as a replacement pattern.
      for (const h of entriesFor(sessionId)) out = out.replace(h.pattern, () => `[vault:${h.name}]`);
      return out;
    },

    /** The name of a held value `text` contains, or null; every chat's when no session is named. */
    find(text: string, sessionId?: string): string | null {
      if (!text) return null;
      const loose = loosen(text);
      for (const h of entriesFor(sessionId)) if (loose.includes(h.loose)) return h.name;
      return null;
    },

    /**
     * The name of a held value found in any string inside `value` (an object, an array, a string),
     * or null. Strings are checked one by one rather than as JSON, where a newline or a quote in a
     * value is escaped and would no longer match.
     */
    findIn(value: unknown, sessionId?: string): string | null {
      const seen = new Set<unknown>();
      const walk = (v: unknown, depth: number): string | null => {
        if (typeof v === "string") return this.find(v, sessionId);
        if (!v || typeof v !== "object" || depth > 20 || seen.has(v)) return null;
        seen.add(v);
        for (const child of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) {
          const hit = walk(child, depth + 1);
          if (hit) return hit;
        }
        return null;
      };
      return walk(value, 0);
    },

    /** Every string inside `value` scrubbed, the same shape returned (unchanged values keep identity). */
    scrubIn<T>(value: T, sessionId?: string): T {
      const walk = (v: unknown, depth: number): unknown => {
        if (typeof v === "string") return this.scrub(v, sessionId);
        if (!v || typeof v !== "object" || depth > 20) return v;
        if (Array.isArray(v)) {
          const next = v.map((c) => walk(c, depth + 1));
          return next.every((c, i) => c === v[i]) ? v : next;
        }
        let changed = false;
        const next: Record<string, unknown> = {};
        for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
          next[k] = walk(c, depth + 1);
          if (next[k] !== c) changed = true;
        }
        return changed ? next : v;
      };
      return walk(value, 0) as T;
    },

    /** Whether anything is held at all (a cheap check before scrubbing a stream). */
    any: (): boolean => live().length > 0,

    release(sessionId: string): void { held.delete(canonical(sessionId)); },
    clear(): void { held.clear(); },
  };
}

export type TurnSecretScrubber = ReturnType<typeof createTurnSecretScrubber>;

let resolveSession: (sessionId: string) => string = (id) => id;
export function setScrubberSessionResolver(fn: (sessionId: string) => string): void { resolveSession = fn; }

export const turnSecretScrubber = createTurnSecretScrubber({ canonical: (id) => resolveSession(id) });
