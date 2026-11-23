/**
 * How a chat turn ended when an error ended it: the provider's last word before `done` was an
 * error, or the run failed outright. Claude's transcript does not record it — the file ends on
 * the last tool result — so a session that hit Max Turns looked as if it had simply stopped
 * mid-thought, and a history reload wiped the one red line that said why.
 */
export interface TurnStop {
  /** The error as the provider worded it; its first line is the headline. */
  message: string;
  /** The SDK result subtype, when the turn reported one (`error_max_turns`, ...). */
  subtype?: string;
  /** When the turn ended, in ms since the epoch. */
  at: number;
}

/** Claude Code no longer had the conversation and PPM did not carry it over (`claude-session-missing.ts`). */
export const isSessionMissingStop = (stop: TurnStop): boolean => stop.subtype === "error_session_missing";

/** The first line of every "gone from Claude Code" stop: the headline the chat's note shows. */
export const SESSION_MISSING_HEAD = "Claude Code no longer has this chat's history";
const RECOVERY_OFF_MARK = "Recovery is off";

/**
 * The stop's text: first line the headline, the rest the detail. `off` says recovery is switched
 * off (the note then offers to switch it on); `no-history` is recovery on with nothing kept.
 */
export function sessionMissingMessage(reason: "off" | "no-history"): string {
  return reason === "off"
    ? `${SESSION_MISSING_HEAD}.\nYour next message starts a new session. ${RECOVERY_OFF_MARK} in Settings → AI Provider.`
    : `${SESSION_MISSING_HEAD}, and PPM kept no copy.\nYour next message starts a new session.`;
}

/** An error event carrying that stop: the chat shows the note instead of an error line. */
export const isSessionMissingMessage = (text: string): boolean => text.startsWith(SESSION_MISSING_HEAD);

/** The stop came with recovery switched off, so turning it on would have saved this chat. */
export const sessionMissingRecoveryOff = (stop: TurnStop): boolean => stop.message.includes(RECOVERY_OFF_MARK);

/** A Claude CLI running on its own sign-in, signed out (`cliSignedOutMessage`). */
export const isCliSignedOutStop = (stop: TurnStop): boolean => stop.message.startsWith("Claude Code on this computer is signed out.");

/** The headline and an optional second line, shared by the chat's stop bar and the notification. */
export function describeTurnStop(stop: TurnStop): { title: string; detail: string | null } {
  if (isSessionMissingStop(stop)) {
    const [, ...rest] = stop.message.split("\n").map((line) => line.trim()).filter(Boolean);
    return { title: SESSION_MISSING_HEAD, detail: rest.length > 0 ? rest.join(" ") : null };
  }
  if (stop.subtype === "error_max_turns") {
    const limit = /maximum number of turns \((\d+)\)/i.exec(stop.message)?.[1];
    return {
      title: limit ? `Stopped after ${limit} steps (Max Turns)` : "Stopped at the Max Turns limit",
      detail: "That is the step limit for one message, set in Settings → AI Provider.",
    };
  }
  const [first, ...rest] = stop.message.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    title: first ? `Stopped: ${first.replace(/\.$/, "")}` : "Stopped by an error",
    detail: rest.length > 0 ? rest.join(" ") : null,
  };
}
