/**
 * How the PPM Assistant's UI tools reach the user's device: over the chat WebSocket, the
 * server sends `assistant_ui` to the one device that sent the Assistant session's latest
 * message — never to every device, because an operation such as switching project or running
 * a command must happen on the screen the user is talking from — and that device answers with
 * `assistant_ui_result` on the same socket. Neither message is buffered for replay.
 *
 * A browser answers only for an Assistant session; any other chat refuses.
 *
 * Every operation the protocol may ever carry is named here so the wire format is fixed; a
 * device answers "unsupported" for one it has no handler for.
 */

export const ASSISTANT_UI_OPS = [
  "get_state",
  "open_tab",
  "focus_tab",
  "close_tab",
  "switch_project",
  "describe_tab",
  "list_commands",
  "run_command",
] as const;
export type AssistantUiOp = (typeof ASSISTANT_UI_OPS)[number];

export const isAssistantUiOp = (value: unknown): value is AssistantUiOp =>
  typeof value === "string" && (ASSISTANT_UI_OPS as readonly string[]).includes(value);

export interface AssistantUiRequest {
  type: "assistant_ui";
  requestId: string;
  op: AssistantUiOp;
  args: Record<string, unknown>;
}

export type AssistantUiResult =
  | { type: "assistant_ui_result"; requestId: string; ok: true; data: unknown }
  | { type: "assistant_ui_result"; requestId: string; ok: false; error: string };

/** The broker's own request ids: 12 random bytes, base64url. */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16}$/;
export const MAX_ASSISTANT_UI_ERROR_CHARS = 500;
/**
 * Largest `data` a device may answer with, as JSON characters. A snapshot is capped well
 * below this on the device; anything bigger is a device that is not ours.
 */
export const MAX_ASSISTANT_UI_DATA_CHARS = 256 * 1024;

/**
 * A device's answer, validated. `data` is passed on as JSON the tool then shapes; its size is
 * bounded here so one answer cannot fill the agent's context or the server's memory.
 */
export function parseAssistantUiResult(raw: unknown): AssistantUiResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "assistant_ui_result" || typeof r.requestId !== "string" || !REQUEST_ID_RE.test(r.requestId)) return null;
  if (r.ok === false) {
    const error = typeof r.error === "string" && r.error.trim() ? r.error.slice(0, MAX_ASSISTANT_UI_ERROR_CHARS) : "The device could not do this.";
    return { type: "assistant_ui_result", requestId: r.requestId, ok: false, error };
  }
  if (r.ok !== true || r.data === undefined) return null;
  let size: number;
  try {
    size = JSON.stringify(r.data).length;
  } catch {
    return null;
  }
  if (size > MAX_ASSISTANT_UI_DATA_CHARS) return null;
  return { type: "assistant_ui_result", requestId: r.requestId, ok: true, data: r.data };
}

/**
 * What `ui_open_tab` may open: a closed set, so no request names an arbitrary component. The
 * server validates `project` and the target against what PPM has registered and sends the
 * device the normalised {@link AssistantOpenTabTarget}; the device checks the project again.
 */
export const ASSISTANT_TAB_KINDS = ["chat", "terminal", "database", "file", "git", "settings"] as const;
export type AssistantTabKind = (typeof ASSISTANT_TAB_KINDS)[number];

export const isAssistantTabKind = (value: unknown): value is AssistantTabKind =>
  typeof value === "string" && (ASSISTANT_TAB_KINDS as readonly string[]).includes(value);

export type AssistantOpenTabTarget =
  /** An existing session (proven to be the project's), or a new chat when `sessionId` is absent. */
  | { kind: "chat"; sessionId?: string; providerId?: "claude" | "codex"; title?: string }
  /** A new terminal in the project's folder. */
  | { kind: "terminal" }
  /** A table's data, or a new Query tab on the connection when `table` is absent. */
  | {
    kind: "database"; connectionId: number; connectionName: string; dbType: string; color?: string;
    database?: string; schema?: string; table?: string;
  }
  /** Relative to the project's folder, or absolute when the file is outside it (`projectName` null). */
  | { kind: "file"; filePath: string; projectName: string | null; line?: number }
  | { kind: "git"; view: "review" | "log" }
  | { kind: "settings"; section?: string };

export interface AssistantOpenTabArgs {
  project: string;
  target: AssistantOpenTabTarget;
}

/**
 * What every navigation answers with: the tab it acted on and the project shown before and
 * after, so the agent can put the screen back (`ui_switch_project` to `previousProject`).
 * `window` names a floating window opened instead of a tab (Settings on a desktop).
 */
export interface AssistantNavResult {
  tabId: string | null;
  project: string | null;
  previousProject: string | null;
  window?: string;
}

/** The tab a close took away, enough to open it again. */
export interface AssistantClosedTab {
  type: string;
  title: string;
  project: string | null;
  details?: Record<string, string | number | boolean>;
}

/**
 * `close_tab`'s answer. A tab whose close would lose something nothing else keeps is not
 * closed; `needsApproval` says why, so the server can ask the user before closing it anyway.
 */
export type AssistantCloseTabResult =
  | { closed: true; tabId: string; closedTab: AssistantClosedTab; project: string | null }
  | { closed: false; tabId: string; needsApproval: { reason: string } };

/**
 * The short picture of the device's screen an Assistant message carries, so the agent knows
 * what the user is looking at without a tool call. Built by the browser, validated and turned
 * into text by the server (`assistant-ui-summary.ts`); titles in it are names users and other
 * AIs gave, so the server treats every string as untrusted.
 */
export interface UiSummaryTab {
  type: string;
  title: string;
  active?: boolean;
}

/** A floating window is listed under `windows` instead, under the title of the tab it hosts. */
export interface UiSummaryPanel {
  area: "grid" | "dock";
  focused?: boolean;
  tabs: UiSummaryTab[];
  /** Tabs left out to keep the summary short. */
  more?: number;
}

export interface UiSummaryWindow {
  kind: string;
  title: string;
  state: string;
}

export interface UiSummary {
  project: string | null;
  layout: "phone" | "desktop";
  panels: UiSummaryPanel[];
  windows: UiSummaryWindow[];
}
