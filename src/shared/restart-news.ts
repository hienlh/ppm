/**
 * The news PPM hands the PPM Assistant after the server restarted: why it restarted (each restart
 * the Assistant has not been told of yet) and which chats a restart cut off mid-turn. Built by the
 * server only; chat titles and prompts in it were written by people and other AIs, so they are
 * data and are checked field by field where they cross the chat control boundary.
 */

/**
 * Why a server process started. `boot` is the supervisor's first spawn shortly after the machine
 * started; `manual` a `ppm start`/`ppm restart` or a restart asked for from a chat; `watchdog` the
 * supervisor killing a server that stopped answering, or anything restarting PPM over its memory
 * that says so; `recycle` a planned restart to give memory back; `crash` the server exiting on its
 * own; `upgrade` a new version; `unknown` when nobody said.
 */
export const START_REASON_KINDS = ["boot", "upgrade", "manual", "watchdog", "recycle", "crash", "unknown"] as const;
export type StartReasonKind = (typeof START_REASON_KINDS)[number];

export interface RestartEntry {
  /** When this server process started. */
  at: number;
  kind: StartReasonKind;
  detail?: string;
  /** The version the previous run had, when it is known and differs. */
  fromVersion?: string;
  toVersion: string;
  /** False when the previous run left no clean stop behind (killed, crashed, power lost); absent when there was none. */
  cleanStop?: boolean;
  /** When the previous run stopped cleanly, and why it says it stopped. */
  stoppedAt?: number;
  stopTrigger?: string;
  /**
   * Why the supervisor stopped the previous run, when it stopped it on purpose without the run
   * writing its own stop (on Windows it always ends the server that way).
   */
  stopOrderedBy?: string;
  /** An upgrade that did not take: the supervisor started the previous version again. */
  upgradeFailed?: boolean;
}

export interface InterruptedChat {
  sessionId: string;
  providerId: string;
  projectName: string;
  title: string;
  /** The first line of the message that opened the cut-off turn. */
  prompt?: string;
  /** The last thing the turn was seen doing ("tool Bash", "writing"). */
  activity?: string;
  /** When the turn's last row was written. */
  lastAt: number;
  /** An approval or question the chat was waiting on when the server went away. */
  pendingApproval?: string;
  /** Open PPM Assistant cards about this chat. */
  openCards?: number;
  /** This chat is its project's manager chat. */
  manager?: boolean;
  /** The chat that opened this one through PPM's session tools. */
  parentSessionId?: string;
  /** The restart it was found at. */
  restartAt: number;
}

export interface RestartNewsPayload {
  /** Oldest first. */
  restarts: RestartEntry[];
  chats: InterruptedChat[];
  /** Cut-off chats left out of the list. */
  moreChats?: number;
  /** The manager chat of each project in the list that has one, as the table says when the news goes out. */
  managers?: Array<{ projectName: string; sessionId: string }>;
}

const MAX_RESTARTS = 20;
const MAX_CHATS = 60;
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const optStr = (v: unknown, max: number) => v === undefined || str(v, max);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseRestart(raw: unknown): RestartEntry | null {
  if (!isRecord(raw)) return null;
  if (!num(raw.at) || !(START_REASON_KINDS as readonly unknown[]).includes(raw.kind) || !str(raw.toVersion, 50)) return null;
  if (!optStr(raw.detail, 400) || !optStr(raw.fromVersion, 50) || !optStr(raw.stopTrigger, 100) || !optStr(raw.stopOrderedBy, 100)) return null;
  if (raw.cleanStop !== undefined && typeof raw.cleanStop !== "boolean") return null;
  if (raw.stoppedAt !== undefined && !num(raw.stoppedAt)) return null;
  if (raw.upgradeFailed !== undefined && typeof raw.upgradeFailed !== "boolean") return null;
  return {
    at: raw.at, kind: raw.kind as StartReasonKind, toVersion: raw.toVersion,
    ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
    ...(typeof raw.fromVersion === "string" ? { fromVersion: raw.fromVersion } : {}),
    ...(typeof raw.cleanStop === "boolean" ? { cleanStop: raw.cleanStop } : {}),
    ...(num(raw.stoppedAt) ? { stoppedAt: raw.stoppedAt } : {}),
    ...(typeof raw.stopTrigger === "string" ? { stopTrigger: raw.stopTrigger } : {}),
    ...(typeof raw.stopOrderedBy === "string" ? { stopOrderedBy: raw.stopOrderedBy } : {}),
    ...(raw.upgradeFailed === true ? { upgradeFailed: true } : {}),
  };
}

function parseChat(raw: unknown): InterruptedChat | null {
  if (!isRecord(raw)) return null;
  if (!str(raw.sessionId, 200) || !str(raw.providerId, 40) || !str(raw.projectName, 300) || !str(raw.title, 400)) return null;
  if (!num(raw.lastAt) || !num(raw.restartAt)) return null;
  if (!optStr(raw.prompt, 400) || !optStr(raw.activity, 200) || !optStr(raw.pendingApproval, 200) || !optStr(raw.parentSessionId, 200)) return null;
  if (raw.openCards !== undefined && (!Number.isInteger(raw.openCards) || (raw.openCards as number) < 0)) return null;
  if (raw.manager !== undefined && typeof raw.manager !== "boolean") return null;
  return {
    sessionId: raw.sessionId, providerId: raw.providerId, projectName: raw.projectName, title: raw.title,
    lastAt: raw.lastAt, restartAt: raw.restartAt,
    ...(typeof raw.prompt === "string" ? { prompt: raw.prompt } : {}),
    ...(typeof raw.activity === "string" ? { activity: raw.activity } : {}),
    ...(typeof raw.pendingApproval === "string" ? { pendingApproval: raw.pendingApproval } : {}),
    ...(typeof raw.openCards === "number" && raw.openCards > 0 ? { openCards: raw.openCards } : {}),
    ...(raw.manager === true ? { manager: true } : {}),
    ...(typeof raw.parentSessionId === "string" ? { parentSessionId: raw.parentSessionId } : {}),
  };
}

/** The payload as the server built it, or null when anything in it is malformed (a bug: refused whole). */
export function parseRestartNews(raw: unknown): RestartNewsPayload | null {
  if (!isRecord(raw) || !Array.isArray(raw.restarts) || !Array.isArray(raw.chats)) return null;
  if (raw.restarts.length === 0 || raw.restarts.length > MAX_RESTARTS || raw.chats.length > MAX_CHATS) return null;
  const restarts = raw.restarts.map(parseRestart);
  const chats = raw.chats.map(parseChat);
  if (restarts.some((r) => !r) || chats.some((c) => !c)) return null;
  if (raw.moreChats !== undefined && (!Number.isInteger(raw.moreChats) || (raw.moreChats as number) < 0)) return null;
  let managers: Array<{ projectName: string; sessionId: string }> | undefined;
  if (raw.managers !== undefined) {
    if (!Array.isArray(raw.managers) || raw.managers.length > MAX_CHATS) return null;
    managers = [];
    for (const m of raw.managers) {
      if (!isRecord(m) || !str(m.projectName, 300) || !str(m.sessionId, 200)) return null;
      managers.push({ projectName: m.projectName, sessionId: m.sessionId });
    }
  }
  return {
    restarts: restarts as RestartEntry[], chats: chats as InterruptedChat[],
    ...(typeof raw.moreChats === "number" && raw.moreChats > 0 ? { moreChats: raw.moreChats } : {}),
    ...(managers?.length ? { managers } : {}),
  };
}
