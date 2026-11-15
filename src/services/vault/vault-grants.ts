import { randomUUID } from "node:crypto";
import { VAULT_SETTINGS_UNLOCK_MS, VAULT_WINDOW_MINUTES, type VaultLockedTier } from "../../shared/vault.ts";

/**
 * The vault's open unlocks, in memory only. There is no "vault is open" state: each unlock is a
 * grant holding its own copy of a data key, for one holder — a chat session, or Settings — and
 * for the secure tier only. The sealed tier never gets a grant: each of its reads unlocks, uses
 * the key once and zeroes it.
 *
 * A chat's grant covers only the items the user ticked on the card that opened it (decision A);
 * an item outside it needs a new card. Settings' grant covers the whole tier for five minutes.
 *
 * A grant that ends — expired, locked by hand, its chat deleted, the server stopping — has its
 * key zeroed. Nothing here survives a restart.
 */

export const SETTINGS_HOLDER = "settings";

interface Grant {
  id: string;
  tier: VaultLockedTier;
  holder: string;
  /** Null for Settings' grant, which covers the whole tier. */
  itemIds: ReadonlySet<string> | null;
  expiresAt: number;
  dek: Buffer;
  timer: ReturnType<typeof setTimeout>;
}

export function createVaultGrants(opts: { now?: () => number; canonical?: (sessionId: string) => string } = {}) {
  const now = opts.now ?? Date.now;
  const canonical = opts.canonical ?? ((id: string) => id);
  const grants = new Map<string, Grant>();

  function end(g: Grant): void {
    clearTimeout(g.timer);
    g.dek.fill(0);
    grants.delete(g.id);
  }

  function add(tier: VaultLockedTier, holder: string, itemIds: ReadonlySet<string> | null, ms: number, dek: Buffer): string {
    if (tier !== "secure") {
      dek.fill(0);
      throw new Error("Only the secure tier can stay open; a sealed key is used once.");
    }
    const id = randomUUID();
    const timer = setTimeout(() => { const g = grants.get(id); if (g) end(g); }, ms);
    (timer as { unref?: () => void }).unref?.();
    grants.set(id, { id, tier, holder, itemIds, expiresAt: now() + ms, dek: Buffer.from(dek), timer });
    dek.fill(0);
    return id;
  }

  /** A live grant for `holder` covering every one of `itemIds`, or null. Drops expired ones. */
  function covering(tier: VaultLockedTier, holder: string, itemIds: readonly string[] | null): Grant | null {
    const h = holder === SETTINGS_HOLDER ? holder : canonical(holder);
    for (const g of [...grants.values()]) {
      if (g.expiresAt <= now()) { end(g); continue; }
      if (g.tier !== tier || (g.holder === SETTINGS_HOLDER ? g.holder : canonical(g.holder)) !== h) continue;
      if (itemIds === null ? g.itemIds === null : (g.itemIds === null || itemIds.every((i) => g.itemIds!.has(i)))) return g;
    }
    return null;
  }

  return {
    /**
     * Keeps the secure tier open for one chat and the ticked items, for 5, 10 or 15 minutes.
     * Takes the key: the caller's buffer is zeroed and the grant keeps a copy of its own.
     */
    openWindow(tier: VaultLockedTier, sessionId: string, itemIds: readonly string[], minutes: number, dek: Buffer): string {
      if (!(VAULT_WINDOW_MINUTES as readonly number[]).includes(minutes)) {
        dek.fill(0);
        throw new Error("A window lasts 5, 10 or 15 minutes.");
      }
      // One window per chat: a new one replaces the old.
      for (const g of [...grants.values()]) if (g.holder !== SETTINGS_HOLDER && canonical(g.holder) === canonical(sessionId)) end(g);
      return add(tier, sessionId, new Set(itemIds), minutes * 60_000, dek);
    },

    /** Keeps the secure tier open for Settings for five minutes; replaces an earlier one. */
    openSettings(tier: VaultLockedTier, dek: Buffer): number {
      for (const g of [...grants.values()]) if (g.holder === SETTINGS_HOLDER && g.tier === tier) end(g);
      add(tier, SETTINGS_HOLDER, null, VAULT_SETTINGS_UNLOCK_MS, dek);
      return now() + VAULT_SETTINGS_UNLOCK_MS;
    },

    /**
     * A copy of the key of a live grant covering the request, for the caller to use and zero; null
     * when none covers it. `itemIds` null asks for the whole tier (Settings).
     */
    keyFor(tier: VaultLockedTier, holder: string, itemIds: readonly string[] | null): Buffer | null {
      const g = covering(tier, holder, itemIds);
      return g ? Buffer.from(g.dek) : null;
    },

    /** When Settings' unlock of `tier` ends, or 0. */
    settingsOpenUntil(tier: VaultLockedTier): number {
      return covering(tier, SETTINGS_HOLDER, null)?.expiresAt ?? 0;
    },

    /** Ends every grant, or every grant of one tier. Answers how many were open. */
    lock(tier?: VaultLockedTier): number {
      let n = 0;
      for (const g of [...grants.values()]) if (!tier || g.tier === tier) { end(g); n++; }
      return n;
    },

    /** Ends a chat's grants (the chat was deleted or the user locked it). */
    lockSession(sessionId: string): void {
      const id = canonical(sessionId);
      for (const g of [...grants.values()]) if (g.holder !== SETTINGS_HOLDER && canonical(g.holder) === id) end(g);
    },

    /** Open grants as status lists them: never a key. */
    list(): { tier: VaultLockedTier; holder: string; expiresAt: number; items: number | null }[] {
      return [...grants.values()].filter((g) => g.expiresAt > now()).map((g) => ({
        tier: g.tier, holder: g.holder, expiresAt: g.expiresAt, items: g.itemIds ? g.itemIds.size : null,
      }));
    },
  };
}

export type VaultGrants = ReturnType<typeof createVaultGrants>;

let resolveSession: (sessionId: string) => string = (id) => id;
/** `ws/chat.ts` registers how to follow a session Codex renamed. */
export function setVaultSessionResolver(fn: (sessionId: string) => string): void { resolveSession = fn; }

export const vaultGrants = createVaultGrants({ canonical: (id) => resolveSession(id) });
