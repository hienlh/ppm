import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { configService } from "../config.service.ts";
import { getDb } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import {
  isVaultItemKind, isVaultLockedTier, isVaultTier, VAULT_MAX_NAME_LENGTH, VAULT_MAX_PASSWORD_LENGTH, VAULT_MAX_VALUE_LENGTH,
  VAULT_MIN_PASSWORD_LENGTH, type VaultItemKind, type VaultItemMeta, type VaultLockedTier, type VaultTier,
} from "../../shared/vault.ts";
import { createVaultAttempts, type VaultAttempts } from "./vault-attempts.ts";
import {
  decryptItem, deriveKek, encryptItem, newDek, newSalt, parseKdfParams, serialized, unwrapDek, VAULT_KDF_PARAMS, wrapDek,
  type KdfParams, type VaultPayload,
} from "./vault-crypto.ts";
import {
  countItems, deleteItemRow, deleteTierRows, getItemRow, getKeyRow, insertItemRow, insertKeyRow, listItemRows, rewrapKeyRow,
  toMeta, updateItemRow, type VaultItemRow,
} from "./vault-db.ts";

/**
 * The vault's rules over its storage: turning a locked tier on, changing or forgetting its
 * password, and adding, editing, moving and deleting items. It never keeps a data key: `unlock`
 * hands one to the caller (the grant registry or a single Settings action), which zeroes it.
 *
 * Logging names ids, tiers and outcomes only — never a value, a password or a request body.
 */

const log = createLogger("vault");

export class VaultError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 | 423 = 400) {
    super(message);
  }
}

export type UnlockResult =
  | { ok: true; dek: Buffer }
  | { ok: false; reason: "not-enabled"; message: string }
  | { ok: false; reason: "locked-out"; retryAfterMs: number; message: string }
  | { ok: false; reason: "wrong-password"; attemptsLeft: number; lockedForMs: number; message: string };
export type UnlockFailure = Exclude<UnlockResult, { ok: true }>;

export interface VaultItemInput {
  tier: VaultTier;
  name: string;
  kind: VaultItemKind;
  value: string;
  note?: string;
}

export interface VaultItemValue extends VaultItemMeta {
  value: string;
  note?: string;
}

const sha = (v: string) => createHash("sha256").update(v, "utf8").digest();

/** Whether `password` is PPM's auth token, which every process of this OS user can read. */
function isAuthToken(password: string): boolean {
  const token = configService.get("auth")?.token;
  return !!token && timingSafeEqual(sha(password), sha(token));
}

function cleanName(name: unknown): string {
  if (typeof name !== "string") throw new VaultError("bad-name", "A name is required.");
  const n = name.trim();
  if (!n) throw new VaultError("bad-name", "A name is required.");
  if (n.length > VAULT_MAX_NAME_LENGTH) throw new VaultError("bad-name", `A name may have at most ${VAULT_MAX_NAME_LENGTH} characters.`);
  if (/[\r\n\u0000]/.test(n)) throw new VaultError("bad-name", "A name must be one line.");
  return n;
}

function cleanValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new VaultError("bad-value", "A value is required.");
  if (value.length > VAULT_MAX_VALUE_LENGTH) throw new VaultError("bad-value", `A value may have at most ${VAULT_MAX_VALUE_LENGTH} characters.`);
  return value;
}

function cleanNote(note: unknown): string | undefined {
  if (note == null || note === "") return undefined;
  if (typeof note !== "string" || note.length > VAULT_MAX_VALUE_LENGTH) throw new VaultError("bad-note", "The note is too long.");
  return note;
}

function cleanKind(kind: unknown): VaultItemKind {
  if (!isVaultItemKind(kind)) throw new VaultError("bad-kind", "Unknown item kind.");
  return kind;
}

export function createVaultService(opts: { attempts?: VaultAttempts; now?: () => number; kdfParams?: () => KdfParams } = {}) {
  const now = opts.now ?? Date.now;
  const attempts = opts.attempts ?? createVaultAttempts({ now });
  const kdfParams = opts.kdfParams ?? (() => VAULT_KDF_PARAMS);

  /** Length and auth-token rules; the other-tier rule needs a derivation and is checked apart. */
  function checkPasswordShape(tier: VaultLockedTier, password: unknown): string {
    if (typeof password !== "string") throw new VaultError("bad-password", "A password is required.");
    const min = VAULT_MIN_PASSWORD_LENGTH[tier];
    if ([...password].length < min) throw new VaultError("weak-password", `The password needs at least ${min} characters.`);
    if (password.length > VAULT_MAX_PASSWORD_LENGTH) throw new VaultError("bad-password", "The password is too long.");
    if (isAuthToken(password)) throw new VaultError("password-is-token", "The vault password must not be PPM's own password.");
    return password;
  }

  /**
   * Refuses `password` when it also opens the other locked tier. Runs inside `serialized`.
   *
   * The answer tells whoever asked whether their candidate is the other tier's password, so each
   * check counts as one try against that tier: it waits out the other tier's lockout and records
   * an attempt, or turning a tier on and off again would be an uncounted way to guess.
   */
  async function checkOtherTier(tier: VaultLockedTier, password: string): Promise<void> {
    const other: VaultLockedTier = tier === "secure" ? "sealed" : "secure";
    const row = getKeyRow(other);
    if (!row) return;
    const gate = attempts.gate(other);
    if (!gate.ok) {
      throw new VaultError("other-tier-locked-out", `Too many wrong passwords on the other tier. Try again in ${Math.ceil(gate.retryAfterMs / 1000)} seconds.`, 423);
    }
    attempts.recordFailure(other);
    const kek = await deriveKek(password, row.salt, parseKdfParams(row.kdf_params));
    const dek = unwrapDek(kek, row.dek_nonce, row.wrapped_dek, other);
    kek.fill(0);
    if (dek) {
      dek.fill(0);
      throw new VaultError(
        "same-as-other-tier",
        tier === "sealed" ? "This password must differ from the Secure tier's password." : "This password must differ from the Sealed tier's password.",
      );
    }
  }

  /** Unwraps `tier`'s data key with `password`, counting a wrong password. Runs inside `serialized`. */
  async function unlockInner(tier: VaultLockedTier, password: unknown): Promise<UnlockResult> {
    const row = getKeyRow(tier);
    if (!row) return { ok: false, reason: "not-enabled", message: "This tier of the vault is not turned on." };
    const gate = attempts.gate(tier);
    if (!gate.ok) {
      const s = Math.ceil(gate.retryAfterMs / 1000);
      return { ok: false, reason: "locked-out", retryAfterMs: gate.retryAfterMs, message: `Too many wrong passwords. Try again in ${s} seconds.` };
    }
    let dek: Buffer | null = null;
    if (typeof password === "string" && password.length > 0 && password.length <= VAULT_MAX_PASSWORD_LENGTH) {
      const kek = await deriveKek(password, row.salt, parseKdfParams(row.kdf_params));
      dek = unwrapDek(kek, row.dek_nonce, row.wrapped_dek, tier);
      kek.fill(0);
    }
    if (!dek) {
      const { attemptsLeft, lockedForMs } = attempts.recordFailure(tier);
      log.warn(`wrong password for tier=${tier}`);
      return { ok: false, reason: "wrong-password", attemptsLeft, lockedForMs, message: "Wrong password" };
    }
    attempts.recordSuccess(tier);
    return { ok: true, dek };
  }

  function existingRow(id: string): VaultItemRow {
    const row = getItemRow(id);
    if (!row) throw new VaultError("not-found", "No such vault item.", 404);
    return row;
  }

  function decryptRow(row: VaultItemRow, dek: Buffer): VaultPayload {
    if (!isVaultLockedTier(row.tier) || !row.nonce || !row.ciphertext) throw new VaultError("bad-row", "This item is damaged.");
    const payload = decryptItem(dek, row.tier, row.id, row.nonce, row.ciphertext);
    if (!payload) throw new VaultError("bad-row", "This item does not open with the tier's key; it may have been tampered with.", 409);
    return payload;
  }

  /** The stored columns for `payload` in `tier`. */
  function sealedColumns(tier: VaultTier, id: string, payload: VaultPayload, dek: Buffer | null) {
    if (tier === "public") return { value_plain: payload.value, ciphertext: null, nonce: null };
    if (!dek) throw new VaultError("locked", "Unlock this tier first.", 423);
    const { nonce, ciphertext } = encryptItem(dek, tier, id, payload);
    return { value_plain: null, ciphertext, nonce };
  }

  return {
    attempts,

    isEnabled: (tier: VaultLockedTier): boolean => !!getKeyRow(tier),

    /** Counts and counters for every tier; `openUntil` reports a Settings unlock, from the grants. */
    status(openUntil: (tier: VaultLockedTier) => number = () => 0) {
      const tier = (t: VaultLockedTier) => {
        const row = getKeyRow(t);
        return {
          enabled: !!row,
          itemCount: countItems(t),
          lockedUntil: row && row.locked_until > now() ? row.locked_until : 0,
          attemptsLeft: attempts.attemptsLeft(t),
          settingsOpenUntil: row ? openUntil(t) : 0,
        };
      };
      return { publicCount: countItems("public"), tiers: { secure: tier("secure"), sealed: tier("sealed") } };
    },

    /** Every item's name, kind and tier, never a value. */
    listItems(tier?: VaultTier): VaultItemMeta[] {
      if (tier !== undefined && !isVaultTier(tier)) throw new VaultError("bad-tier", "Unknown vault tier.");
      return listItemRows(tier).map(toMeta);
    },

    getMeta(id: string): VaultItemMeta | null {
      const row = getItemRow(id);
      return row ? toMeta(row) : null;
    },

    /** Turns a locked tier on with its password. Forgetting that password loses the tier for good. */
    enableTier(tier: VaultLockedTier, password: unknown): Promise<void> {
      if (!isVaultLockedTier(tier)) return Promise.reject(new VaultError("bad-tier", "Only the Secure and Sealed tiers have a password."));
      let pw: string;
      try { pw = checkPasswordShape(tier, password); } catch (e) { return Promise.reject(e); }
      return serialized(async () => {
        if (getKeyRow(tier)) throw new VaultError("already-enabled", "This tier is already turned on.", 409);
        await checkOtherTier(tier, pw);
        const params = kdfParams();
        const salt = newSalt();
        const dek = newDek();
        const kek = await deriveKek(pw, salt, params);
        try {
          const { nonce, wrapped } = wrapDek(kek, dek, tier);
          insertKeyRow({ tier, kdf: "scrypt", kdf_params: JSON.stringify(params), salt, dek_nonce: nonce, wrapped_dek: wrapped, created_at: now() });
        } finally {
          kek.fill(0);
          dek.fill(0);
        }
        log.info(`tier=${tier} turned on`);
      });
    },

    /** The tier's data key for `password`; the caller zeroes it. A wrong password is counted. */
    unlock(tier: VaultLockedTier, password: unknown): Promise<UnlockResult> {
      if (!isVaultLockedTier(tier)) return Promise.resolve({ ok: false, reason: "not-enabled", message: "Unknown vault tier." });
      return serialized(() => unlockInner(tier, password));
    },

    /** Re-wraps the tier's data key under a new password; items stay as they are. */
    changePassword(tier: VaultLockedTier, oldPassword: unknown, newPassword: unknown): Promise<{ ok: true } | UnlockFailure> {
      let pw: string;
      try { pw = checkPasswordShape(tier, newPassword); } catch (e) { return Promise.reject(e); }
      return serialized(async () => {
        const opened = await unlockInner(tier, oldPassword);
        if (!opened.ok) return opened;
        const dek = opened.dek;
        let kek: Buffer | null = null;
        try {
          await checkOtherTier(tier, pw);
          const params = kdfParams();
          const salt = newSalt();
          kek = await deriveKek(pw, salt, params);
          const { nonce, wrapped } = wrapDek(kek, dek, tier);
          rewrapKeyRow(tier, JSON.stringify(params), salt, nonce, wrapped);
          log.info(`tier=${tier} password changed`);
          return { ok: true } as const;
        } finally {
          kek?.fill(0);
          dek.fill(0);
        }
      });
    },

    /** Forgets a locked tier: its key and every item in it. Needs the tier's password. */
    deleteTier(tier: VaultLockedTier, password: unknown): Promise<{ ok: true; removed: number } | UnlockFailure> {
      return serialized(async () => {
        const opened = await unlockInner(tier, password);
        if (!opened.ok) return opened;
        opened.dek.fill(0);
        const removed = deleteTierRows(tier);
        log.info(`tier=${tier} deleted with ${removed} item(s)`);
        return { ok: true, removed } as const;
      });
    },

    /** Adds an item. A locked tier needs its data key, from an unlock. */
    addItem(input: VaultItemInput, dek: Buffer | null = null): VaultItemMeta {
      if (!isVaultTier(input.tier)) throw new VaultError("bad-tier", "Unknown vault tier.");
      if (isVaultLockedTier(input.tier) && !getKeyRow(input.tier)) throw new VaultError("not-enabled", "Turn this tier on first.", 409);
      const id = randomUUID();
      const t = now();
      const payload: VaultPayload = { value: cleanValue(input.value), note: cleanNote(input.note) };
      const row: VaultItemRow = {
        id, tier: input.tier, name: cleanName(input.name), kind: cleanKind(input.kind),
        ...sealedColumns(input.tier, id, payload, dek), created_at: t, updated_at: t,
      };
      insertItemRow(row);
      log.info(`item=${id} added to tier=${input.tier}`);
      return toMeta(row);
    },

    /** Renames, re-kinds or rewrites an item in place. A locked tier needs its data key. */
    updateItem(id: string, patch: { name?: string; kind?: VaultItemKind; value?: string; note?: string }, dek: Buffer | null = null): VaultItemMeta {
      const row = existingRow(id);
      const next: VaultItemRow = { ...row, updated_at: now() };
      if (patch.name !== undefined) next.name = cleanName(patch.name);
      if (patch.kind !== undefined) next.kind = cleanKind(patch.kind);
      if (row.tier === "public") {
        if (patch.value !== undefined) next.value_plain = cleanValue(patch.value);
      } else {
        // Even a rename needs the key: it proves the tier is open, and re-encrypting keeps the
        // nonce fresh on every write.
        if (!dek) throw new VaultError("locked", "Unlock this tier first.", 423);
        const current = decryptRow(row, dek);
        const payload: VaultPayload = {
          value: patch.value !== undefined ? cleanValue(patch.value) : current.value,
          note: patch.note !== undefined ? cleanNote(patch.note) : current.note,
        };
        Object.assign(next, sealedColumns(row.tier, id, payload, dek));
      }
      updateItemRow(next);
      log.info(`item=${id} updated in tier=${row.tier}`);
      return toMeta(next);
    },

    /** Deletes an item. A locked tier needs its data key, proved by opening the item with it. */
    deleteItem(id: string, dek: Buffer | null = null): void {
      const row = existingRow(id);
      if (row.tier !== "public") {
        if (!dek) throw new VaultError("locked", "Unlock this tier first.", 423);
        decryptRow(row, dek);
      }
      deleteItemRow(id);
      log.info(`item=${id} deleted from tier=${row.tier}`);
    },

    /** Public items' values by id. Throws for an id that is not a public item. */
    readPublic(ids: readonly string[]): VaultItemValue[] {
      return ids.map((id) => {
        const row = getItemRow(id);
        if (!row || row.tier !== "public") throw new VaultError("not-found", "No such public item.", 404);
        return { ...toMeta(row), value: row.value_plain ?? "" };
      });
    },

    /** Locked items' values by id under `dek`. Throws for an id outside `tier`. */
    readLocked(tier: VaultLockedTier, ids: readonly string[], dek: Buffer): VaultItemValue[] {
      return ids.map((id) => {
        const row = getItemRow(id);
        if (!row || row.tier !== tier) throw new VaultError("not-found", `No such ${tier} item.`, 404);
        const payload = decryptRow(row, dek);
        return { ...toMeta(row), value: payload.value, ...(payload.note ? { note: payload.note } : {}) };
      });
    },

    /**
     * Moves an item to another tier: decrypted from its tier and written under the target's key
     * and additional data, in one transaction. Each locked tier involved needs its data key.
     */
    moveItem(id: string, to: VaultTier, keys: { from?: Buffer | null; to?: Buffer | null }): VaultItemMeta {
      if (!isVaultTier(to)) throw new VaultError("bad-tier", "Unknown vault tier.");
      const row = existingRow(id);
      if (row.tier === to) return toMeta(row);
      if (isVaultLockedTier(to) && !getKeyRow(to)) throw new VaultError("not-enabled", "Turn that tier on first.", 409);
      const payload: VaultPayload = row.tier === "public"
        ? { value: row.value_plain ?? "" }
        : (() => {
          if (!keys.from) throw new VaultError("locked", "Unlock the item's tier first.", 423);
          return decryptRow(row, keys.from);
        })();
      if (isVaultLockedTier(to) && !keys.to) throw new VaultError("locked", "Unlock the target tier first.", 423);
      const next: VaultItemRow = { ...row, tier: to, ...sealedColumns(to, id, payload, keys.to ?? null), updated_at: now() };
      getDb().transaction(() => { updateItemRow(next); })();
      log.info(`item=${id} moved tier=${row.tier} -> tier=${to}`);
      return toMeta(next);
    },
  };
}

export type VaultService = ReturnType<typeof createVaultService>;

export const vaultService = createVaultService();
