/**
 * PPM's secret vault, in three tiers kept apart on purpose:
 *
 * - `public`: plain text in `ppm.db`. The AI reads it freely; it may reach Telegram and the
 *   session trace like any other data. Not for secrets.
 * - `secure`: encrypted under a data key of its own, wrapped by the vault password (MK2). The AI
 *   reads it through a card the user answers in PPM, once or for a few minutes.
 * - `sealed`: encrypted under a second, separate key and password (MK3, never the same as MK2).
 *   One item per card, shown to the user by default; the AI gets the value only when the user
 *   says so for that one read. Never opened for a period of time.
 *
 * Neither password nor key is ever written to disk: a key lives in memory only while a grant is
 * open, and a restart locks both tiers. Nothing here is shared with PPM's own password (the
 * auth token), which every process of this OS user can read.
 */

export const VAULT_TIERS = ["public", "secure", "sealed"] as const;
export type VaultTier = (typeof VAULT_TIERS)[number];
/** The tiers that are encrypted and have a password of their own. */
export const VAULT_LOCKED_TIERS = ["secure", "sealed"] as const;
export type VaultLockedTier = (typeof VAULT_LOCKED_TIERS)[number];

export const VAULT_ITEM_KINDS = ["ni_number", "address", "passport", "other"] as const;
export type VaultItemKind = (typeof VAULT_ITEM_KINDS)[number];

export const isVaultTier = (v: unknown): v is VaultTier => typeof v === "string" && (VAULT_TIERS as readonly string[]).includes(v);
export const isVaultLockedTier = (v: unknown): v is VaultLockedTier => v === "secure" || v === "sealed";
export const isVaultItemKind = (v: unknown): v is VaultItemKind => typeof v === "string" && (VAULT_ITEM_KINDS as readonly string[]).includes(v);

/** Shortest password each locked tier accepts. */
export const VAULT_MIN_PASSWORD_LENGTH: Record<VaultLockedTier, number> = { secure: 12, sealed: 16 };
/** Longest password, name and value the vault accepts (bounded so scrypt and storage stay sane). */
export const VAULT_MAX_PASSWORD_LENGTH = 1_000;
export const VAULT_MAX_NAME_LENGTH = 120;
export const VAULT_MAX_VALUE_LENGTH = 8_000;

/** How long a secure-tier window may stay open for one chat, in minutes. */
export const VAULT_WINDOW_MINUTES = [5, 10, 15] as const;
export type VaultWindowMinutes = (typeof VAULT_WINDOW_MINUTES)[number];
/** How long Settings keeps the secure tier open after the password. */
export const VAULT_SETTINGS_UNLOCK_MS = 5 * 60_000;

/** An item as anyone may list it: never its value, whatever the tier. */
export interface VaultItemMeta {
  id: string;
  tier: VaultTier;
  name: string;
  kind: VaultItemKind;
  createdAt: number;
  updatedAt: number;
}

export interface VaultTierStatus {
  enabled: boolean;
  itemCount: number;
  /** Epoch ms until which a password is not even tried; 0 when not locked out. */
  lockedUntil: number;
  /** Wrong passwords left before the next temporary lockout. */
  attemptsLeft: number;
  /** For `secure`: when the Settings unlock ends (epoch ms), or 0. Never set for `sealed`. */
  settingsOpenUntil: number;
}

export interface VaultStatus {
  publicCount: number;
  tiers: Record<VaultLockedTier, VaultTierStatus>;
}

/** Labels the UI and the AI's results use; the ids above never change. */
export const VAULT_TIER_LABELS: Record<VaultTier, string> = { public: "Public", secure: "Secure", sealed: "Sealed" };
export const VAULT_KIND_LABELS: Record<VaultItemKind, string> = {
  ni_number: "NI number", address: "Address", passport: "Passport", other: "Other",
};

/** Names that suggest a secret was put in the public tier; the UI warns and suggests `secure`. */
export function looksSecretName(name: string): boolean {
  return /\b(ni|nino|national ?insurance|passport|password|passwd|pass|pin|ssn|tax|bank|iban|sort ?code|card|cvv|secret|token|key|otp|seed|mnemonic|dob|birth)\b/i.test(name)
    || /mật ?khẩu|hộ chiếu|số tài khoản|cmnd|cccd/i.test(name);
}
