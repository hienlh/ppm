/**
 * Full mode for the PPM Assistant (Settings → PPM Assistant → Permissions): in a turn the user
 * started, in PPM or on Telegram, PPM's own approval cards are answered "approved" by PPM itself,
 * the way a chat in bypass mode runs without asking. The user chose it as "giống như chat với một
 * session bypass": the Assistant works on what it is asked, including in a turn that has already
 * read a web page, a file or another chat.
 *
 * What still shows a card, or is refused, whatever the mode (the hard limits):
 *  - a turn PPM started (watch reports, wake-ups, restart news, the digest, schedules) — refused
 *    by the asker before this module is asked, as in Ask mode; and a turn whose start PPM did not
 *    see (a restart mid-turn), which counts as not the user's;
 *  - the vault's locked tiers, whose cards take a password and never pass through here;
 *  - anything that leaves the machine or reaches other people: a git push, switching PPM's public
 *    link on, a port forwarded to a public Cloudflare address;
 *  - another chat's approval card (`chat_answer_approval`): the user has not seen what that chat
 *    wants to do, and it may be one of the actions above;
 *  - an extension's command, which may post or publish, and an edit to a connection listed as
 *    writable, which could move its unasked writes to another database;
 *  - a database write, unless the user listed the connection as writable without a card;
 *  - a read of a folder PPM keeps private (the PPM dir, credential stores): what it holds could
 *    leave in the Assistant's answer, which also goes to Telegram;
 *  - more than {@link FULL_MODE_PER_TURN} actions in one turn or {@link FULL_MODE_PER_HOUR} in an
 *    hour: the next one asks, which stops a loop running away.
 * Provider tools (shell, files, web, the user's own MCP servers) follow `assistant-shell-decision.ts`,
 * where Full is "act on its own" plus the same outbound limit.
 *
 * Every action this module lets through is written to the session trace, so what ran without a
 * card can be read back next to what the user approved.
 */
import { CHAT_ANSWER_APPROVAL_TOOL, DB_QUERY_TOOL, UI_RUN_COMMAND_TOOL } from "../../shared/assistant-tool-names.ts";
import { DB_CONNECTION_SAVE_TOOL } from "../../shared/assistant-db-connection-tool-names.ts";
import { GIT_SYNC_TOOL } from "../../shared/assistant-git-tool-names.ts";
import { PORT_FORWARD_START_TOOL, PUBLIC_LINK_SET_TOOL } from "../../shared/assistant-tunnel-tool-names.ts";
import { CREATE_SESSION_TOOL, SEND_TO_SESSION_TOOL } from "../../shared/session-collab.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-full-mode");

/** Actions one turn may run without a card before the next one asks. */
export const FULL_MODE_PER_TURN = 10;
/** Actions all Assistant sessions together may run without a card in a rolling hour. */
export const FULL_MODE_PER_HOUR = 30;
const HOUR_MS = 60 * 60_000;

/** What a card would have asked about; `connectionId` is set for a database write. */
export interface FullModeAction {
  tool: string;
  input: Record<string, unknown>;
  connectionId?: number;
  /** It reads or writes a folder PPM keeps private (`assistant-private-paths.ts`). */
  touchesPrivate?: boolean;
}

export type FullModeVerdict =
  | { run: true }
  | { run: false; reason: string };

export interface FullModeDeps {
  /** Settings → PPM Assistant → Permissions is on Full. */
  fullMode(): boolean;
  /** A turn the user opened (in PPM or on Telegram) is running in this session, as PPM saw it start. */
  userStartedTurn(sessionId: string): Promise<boolean>;
  /** Connection ids listed as writable without a card. */
  dbWriteConnections(): ReadonlySet<number>;
  /** Records an action that ran without a card. */
  record(sessionId: string, entry: Record<string, unknown>): void;
  now(): number;
}

/**
 * Why `action` asks even in Full mode, or null when it is not one of the hard limits. Pure: the
 * decision table the unit tests walk.
 */
export function hardLimitReason(action: FullModeAction, dbWritable: ReadonlySet<number>): string | null {
  const { tool, input } = action;
  if (action.touchesPrivate) return "it reaches a folder PPM keeps private, whose contents could leave in an answer or on Telegram";
  if (tool === GIT_SYNC_TOOL && input.action === "push") return "a push sends commits off this machine";
  if (tool === PUBLIC_LINK_SET_TOOL && input.enabled === true) return "it puts PPM on a public address";
  if (tool === PORT_FORWARD_START_TOOL && input.via !== "tailscale") return "it gives the port a public address";
  if (tool === CHAT_ANSWER_APPROVAL_TOOL) return "it answers another chat's card, whose action the user has not seen";
  if (tool === DB_QUERY_TOOL) {
    return action.connectionId !== undefined && dbWritable.has(action.connectionId)
      ? null
      : "database writes ask unless the connection is listed as writable in Settings";
  }
  // The writable list is kept by id: an edit could point a listed connection at another database
  // (a SQLite file, a URL with no saved password) and its writes would then go there unasked.
  if (tool === DB_CONNECTION_SAVE_TOOL && typeof input.id === "number" && dbWritable.has(input.id)) {
    return "it changes a connection listed as writable without a card";
  }
  // An extension's command does whatever its extension does, posting included: the same as a
  // user MCP tool that may send, which asks too.
  if (tool === UI_RUN_COMMAND_TOOL && typeof input.id === "string" && input.id.startsWith("ext:")) {
    return "an extension's command may send or publish";
  }
  return null;
}

/** The session tools Full mode answers itself; their other cards (pair limits, escalations) keep asking. */
export const FULL_MODE_SESSION_TOOLS: ReadonlySet<string> = new Set([CREATE_SESSION_TOOL, SEND_TO_SESSION_TOOL]);

export function createFullMode(deps: FullModeDeps) {
  const perTurn = new Map<string, number>();
  let recent: number[] = [];

  return {
    /**
     * Whether PPM may answer this card itself. Read per call — the switch, the turn and the
     * counts — so a switch turned off takes effect at the next action.
     */
    async verdict(sessionId: string, action: FullModeAction): Promise<FullModeVerdict> {
      if (!deps.fullMode()) return { run: false, reason: "the Assistant is in Ask mode" };
      if (!(await deps.userStartedTurn(sessionId).catch(() => false))) {
        return { run: false, reason: "Full mode applies only to turns the user started" };
      }
      const hard = hardLimitReason(action, deps.dbWriteConnections());
      if (hard) return { run: false, reason: hard };
      const now = deps.now();
      recent = recent.filter((t) => now - t < HOUR_MS);
      const turnCount = perTurn.get(sessionId) ?? 0;
      if (turnCount >= FULL_MODE_PER_TURN) return { run: false, reason: `${FULL_MODE_PER_TURN} actions already ran without a card in this turn` };
      if (recent.length >= FULL_MODE_PER_HOUR) return { run: false, reason: `${FULL_MODE_PER_HOUR} actions already ran without a card in the last hour` };
      perTurn.set(sessionId, turnCount + 1);
      recent.push(now);
      try {
        deps.record(sessionId, { tool: action.tool, input: action.input, mode: "full" });
      } catch (err) {
        log.warn(`could not record a Full-mode action: ${(err as Error)?.message ?? String(err)}`);
      }
      return { run: true };
    },

    /** The session's turn ended: its per-turn count starts again. */
    turnEnded(sessionId: string): void {
      perTurn.delete(sessionId);
    },

    /** A provider renamed the session mid-turn (Codex): the count moves with it rather than restarting. */
    migrated(from: string, to: string): void {
      const count = perTurn.get(from);
      if (count === undefined) return;
      perTurn.delete(from);
      perTurn.set(to, Math.max(count, perTurn.get(to) ?? 0));
    },

    /** For tests. */
    reset(): void {
      perTurn.clear();
      recent = [];
    },
  };
}

export type FullMode = ReturnType<typeof createFullMode>;
