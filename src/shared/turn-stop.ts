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

/** The headline and an optional second line, shared by the chat's stop bar and the notification. */
export function describeTurnStop(stop: TurnStop): { title: string; detail: string | null } {
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
