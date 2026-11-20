/**
 * The settings the PPM Assistant changed, as the change log stores them and as the chat card, the
 * Changes tab and Telegram show them. Shared by the server (`src/services/assistant-settings-tools/`)
 * and the browser.
 *
 * A secret never appears here: the catalog refuses secret keys outright, and a change that drops a
 * stored secret as a side effect (a new ntfy server removes its token) says so in `note`, with no
 * value.
 */

/** Where the turn that made the change was typed. */
export type SettingChangeOrigin = "ppm" | "telegram";

/**
 * How the change was allowed: `full` — Full mode, no card; `card` — the user allowed a card;
 * `user` — the user's own Undo button (never the AI).
 */
export type SettingChangeApproval = "full" | "card" | "user";

/** A setting value changed, an install or an uninstall. */
export type SettingChangeKind = "setting" | "install" | "uninstall";

export interface SettingChangeRow {
  id: number;
  /** Epoch ms. */
  at: number;
  sessionId: string | null;
  origin: SettingChangeOrigin;
  approval: SettingChangeApproval;
  kind: SettingChangeKind;
  /** The catalog key, e.g. `voice.cleanup_enabled`, or `install:whisper`. */
  key: string;
  /** "Voice Input → Haiku clean-up". */
  label: string;
  /** JSON values, as stored; null when there was none (an install). */
  before: unknown;
  after: unknown;
  /** The values as a person reads them: "On", "After 1 minute". */
  beforeText: string | null;
  afterText: string | null;
  note: string | null;
  /** This row undoes row `undoes`. */
  undoes: number | null;
  /** Set once another row undid this one. */
  undoneAt: number | null;
  undoneBy: number | null;
}

/** Why a row cannot be undone now, or null when it can. Computed by the server per request. */
export type SettingUndoBlock =
  | { reason: "undone" }
  | { reason: "moved"; current: string }
  | { reason: "not_undoable"; detail: string };

export interface SettingChangeView extends SettingChangeRow {
  undo: SettingUndoBlock | null;
}

/** The answer of `GET /api/assistant/settings-changes`. */
export interface SettingChangesList {
  enabled: boolean;
  changes: SettingChangeView[];
}

/** Kept this long, then pruned. */
export const SETTING_CHANGES_RETENTION_DAYS = 90;

/**
 * What `settings_set`, `settings_undo` and `settings_install` answer, in the tool's JSON result.
 * The chat card reads it (`src/web/lib/settings-tool-call.ts`), so it is a contract: fields are only
 * ever added.
 */
export interface SettingsToolChange {
  changeId: number;
  key: string;
  label: string;
  before: string | null;
  after: string | null;
  note?: string;
}

export interface SettingsToolResult {
  outcome: "changed" | "unchanged" | "stale" | "installing" | "installed" | "uninstalled" | "undone";
  /** How the change was allowed (absent when nothing changed). */
  approval?: SettingChangeApproval;
  changes: SettingsToolChange[];
  /** An install still running: what `settings_install_status` takes. */
  install?: { component: string; option: string | null };
  note?: string;
}

/** On `/ws/global` (and then on `window`) after the change log moved: the Changes tab reads it again. */
export const SETTING_CHANGES_EVENT = "assistant:settings_changes_changed";

/** `/api/assistant/settings-changes`, mounted with the other Assistant routes. */
export const SETTING_CHANGES_API = "/api/assistant/settings-changes";
