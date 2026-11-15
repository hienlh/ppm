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

export const HOLD_MS = 15 * 60_000;
/** Shorter values would match ordinary text; the scrubber leaves them alone. */
const MIN_VALUE_CHARS = 4;

interface Held { name: string; pattern: RegExp; loose: string }
interface Entry { items: Held[]; until: number }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const loosen = (s: string) => s.replace(/\s+/g, "").toLowerCase();

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
        if (loosen(value).length < MIN_VALUE_CHARS) continue;
        const loose = loosen(value);
        if (!entry.items.some((h) => h.loose === loose)) entry.items.push({ name, pattern: patternFor(value), loose });
      }
      entry.until = now() + HOLD_MS;
      if (entry.items.length) held.set(id, entry);
    },

    /** `text` with every held value replaced by `[vault:<name>]`; every chat's when no session is named. */
    scrub(text: string, sessionId?: string): string {
      let out = text;
      for (const h of entriesFor(sessionId)) out = out.replace(h.pattern, `[vault:${h.name}]`);
      return out;
    },

    /** The name of a held value `text` contains, or null; every chat's when no session is named. */
    find(text: string, sessionId?: string): string | null {
      if (!text) return null;
      const loose = loosen(text);
      for (const h of entriesFor(sessionId)) if (loose.includes(h.loose)) return h.name;
      return null;
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
