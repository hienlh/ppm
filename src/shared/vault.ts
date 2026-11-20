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
  /** Files attached to a secure or sealed item: label, type and size only. */
  attachments?: VaultAttachmentMeta[];
}

// ---------------------------------------------------------------------------
// Files attached to an item
// ---------------------------------------------------------------------------

/**
 * A photo or PDF attached to an item of a locked tier (a passport scan, an NI card, a bill).
 * Encrypted under that tier's data key and kept on disk under the PPM directory. The original
 * file name is encrypted too: what anyone may list is the label the user gave it, the type and
 * the size. Only the user sees a file, in PPM, on the device that unlocked it; no AI reads one.
 */
export const VAULT_FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type VaultFileType = (typeof VAULT_FILE_TYPES)[number];
export const isVaultFileType = (v: unknown): v is VaultFileType => typeof v === "string" && (VAULT_FILE_TYPES as readonly string[]).includes(v);

export const VAULT_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const VAULT_FILES_PER_ITEM = 10;
export const VAULT_FILES_TOTAL_BYTES = 200 * 1024 * 1024;
export const VAULT_MAX_LABEL_LENGTH = 120;
/** How long a file opened for preview stays on screen before it closes itself. */
export const VAULT_FILE_PREVIEW_MS = 60_000;
/** The longest side a photo is shrunk to before upload, unless the user keeps the original. */
export const VAULT_PHOTO_MAX_SIDE = 2_000;

export interface VaultAttachmentMeta {
  id: string;
  itemId: string;
  label: string;
  type: VaultFileType;
  size: number;
  createdAt: number;
  updatedAt: number;
}

export const VAULT_FILE_TYPE_LABELS: Record<VaultFileType, string> = {
  "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP", "application/pdf": "PDF",
};

/** "412 KB", "2.9 MB". */
export function formatVaultFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What Settings → Vault says before a tier is deleted: its files stay in older backups. */
export const VAULT_DELETE_TIER_BACKUP_NOTE =
  "Older backups of PPM's database keep this tier's encrypted items and files until they age out (about four weeks). They still open only with this tier's password.";

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

// ---------------------------------------------------------------------------
// The vault's cards in a chat
// ---------------------------------------------------------------------------

/**
 * The `tool` of every vault card. Not a provider's tool name, so the chat draws the vault's own
 * card; `input.kind` says which card. Answered over HTTP (`POST /api/vault/cards/:requestId`),
 * never over the chat socket, and never from Telegram or by the Assistant on the user's behalf.
 */
export const VAULT_CARD_APPROVAL = "ppm:vault";

export interface VaultCardItem { id: string; name: string; kind: VaultItemKind }

export interface VaultCardRequester {
  /** The chat that asked, as PPM names it. */
  sessionTitle: string | null;
  assistant: boolean;
  /** The turn was started from Telegram: the answer goes back there. */
  fromTelegram: boolean;
}

export type VaultCardInput =
  | {
    kind: "read-secure";
    requester: VaultCardRequester;
    purpose: string;
    /** Every secure item, so the user can tick more than the AI asked for. */
    items: VaultCardItem[];
    /** The items the AI asked for, ticked to begin with. */
    requested: string[];
    attemptsLeft: number;
    lockedUntil: number;
  }
  | {
    kind: "read-sealed";
    requester: VaultCardRequester;
    purpose: string;
    item: VaultCardItem;
    /** False for a turn started from Telegram: the value is only ever shown to the user then. */
    allowGiveToAi: boolean;
    attemptsLeft: number;
    lockedUntil: number;
  }
  | {
    kind: "propose";
    requester: VaultCardRequester;
    name: string;
    itemKind: VaultItemKind;
    suggestedTier: VaultTier;
    /** The AI filled in a value; the card fetches it masked (`GET .../prefill`), never over the socket. */
    hasPrefill: boolean;
    enabled: Record<VaultLockedTier, boolean>;
  };

export interface VaultCardAnswer {
  approved: boolean;
  password?: string;
  /** read-secure: the ticked items. */
  itemIds?: string[];
  /** read-secure: once (default) or a window for this chat. */
  mode?: "once" | "window";
  minutes?: number;
  /** read-sealed: give the value to the AI this once (otherwise it is shown to the user only). */
  giveToAi?: boolean;
  /** propose: what the user settled on. */
  tier?: VaultTier;
  name?: string;
  itemKind?: VaultItemKind;
  value?: string;
}

/** What the card's HTTP answer returns: a sealed value shown to the user travels only here. */
export interface VaultCardAnswerResult {
  approved: boolean;
  shown?: { name: string; value: string };
}

/** What happens to a value once the AI was given it: shown on the cards and in Settings. */
export const VAULT_HISTORY_LIMIT = "After the turn PPM removes the value from the chat's history files on this machine; the open chat keeps it in memory until it is reopened, and what was sent to Anthropic or OpenAI cannot be removed.";

/**
 * The address inside PPM that opens Settings → Vault, on one item when given: `/?openVault=<id>`
 * (`all` for the pane itself). It carries an item id and nothing else — no value, no token — and
 * goes through PPM's sign-in like any other page; a locked tier still asks for its password there.
 */
export const VAULT_LINK_PARAM = "openVault";
export const VAULT_LINK_ALL = "all";
const VAULT_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isVaultItemId = (v: unknown): v is string => typeof v === "string" && VAULT_ITEM_ID.test(v);
export function vaultSettingsPath(itemId?: string | null): string {
  return `/?${VAULT_LINK_PARAM}=${itemId && isVaultItemId(itemId) ? itemId : VAULT_LINK_ALL}`;
}

/** A push or ntfy notification about a vault card (it can land on a lock screen): no item, tier or purpose. The Telegram notice names the item and tier (`assistant-telegram-db-notices.ts`). */
export const VAULT_NOTIFICATION_BODY = "Unlock needed in the PPM vault";

/** How long a sealed value shown on the card stays visible before it hides itself. */
export const VAULT_SHOW_MS = 60_000;

// ---------------------------------------------------------------------------
// The AI's vault tools
// ---------------------------------------------------------------------------

/**
 * Served on PPM's session server (`ppm-sessions` / `ppm_sessions`), which every chat that may have
 * them already gets: the PPM Assistant always, an ordinary chat only while the user turned them on
 * in Settings → Tools (off by default), a design or extension-bound chat never.
 */
export const VAULT_LIST_TOOL = "vault_list";
export const VAULT_READ_TOOL = "vault_read";
export const VAULT_PROPOSE_TOOL = "vault_propose";
export const VAULT_TOOLS = [VAULT_LIST_TOOL, VAULT_READ_TOOL, VAULT_PROPOSE_TOOL] as const;
export const isVaultTool = (name: unknown): boolean => (VAULT_TOOLS as readonly unknown[]).includes(name);
