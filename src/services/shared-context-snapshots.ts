import { createHash } from "node:crypto";

/**
 * What a session's model was last sent in the `<ppm-shared-context>` block, per entry, so an
 * entry that has not changed since is left out of the next message. Each entry is tracked
 * apart: the PPM Assistant's picture of the screen changes on most turns, and re-sending the
 * project's shared instructions every time it does would cost far more than the picture.
 *
 * Delivery hints only: a restart or an eviction just sends a fresh copy.
 */
export type SharedContextPart = "shared" | "ui";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export class SharedContextSnapshots {
  private readonly sent = new Map<string, Partial<Record<SharedContextPart, string>>>();

  constructor(private readonly max = 512) {}

  /** True when `text` is exactly what the session's model last received for this entry. */
  unchanged(key: string, part: SharedContextPart, text: string): boolean {
    return this.sent.get(key)?.[part] === hash(text);
  }

  /** Records the entries a message carried; entries it left out keep their last record. */
  remember(key: string, parts: Partial<Record<SharedContextPart, string>>): void {
    const updates = Object.entries(parts).filter(([, text]) => !!text) as Array<[SharedContextPart, string]>;
    if (!updates.length) return;
    const next = { ...this.sent.get(key) };
    for (const [part, text] of updates) next[part] = hash(text);
    // Re-inserted so the map's order is least recently used first.
    this.sent.delete(key);
    this.sent.set(key, next);
    if (this.sent.size > this.max) this.sent.delete(this.sent.keys().next().value!);
  }

  /** Forgets one entry, or all of them, so the next message sends them again. */
  forget(key: string, part?: SharedContextPart): void {
    if (!part) {
      this.sent.delete(key);
      return;
    }
    const entry = this.sent.get(key);
    if (!entry) return;
    delete entry[part];
    if (!Object.keys(entry).length) this.sent.delete(key);
  }

  /** Moves a session's records to the id its provider renamed it to. */
  move(from: string, to: string): void {
    const entry = this.sent.get(from);
    if (!entry) return;
    this.sent.set(to, entry);
    this.sent.delete(from);
  }
}
