import type { GroupMessage } from "../../types/group-chat.ts";

export const DEFAULT_WINDOW = 8;
export const DEFAULT_SUMMARY_CAP = 800;

export interface WindowedContext {
  window: GroupMessage[];
  rollingSummary: string;
}

function line(m: GroupMessage): string {
  const to = m.toMember ?? "all";
  return `${m.fromMember} -> ${to}: ${m.summary ?? ""}`.trim();
}

/** Split messages into a last-N window + a naive rolling summary of the older
 *  pre-window turns (PPM-side, no API): concatenate then cap length. */
export function buildContextWindow(
  messages: GroupMessage[],
  window = DEFAULT_WINDOW,
  summaryCap = DEFAULT_SUMMARY_CAP,
): WindowedContext {
  if (messages.length <= window) {
    return { window: messages.slice(), rollingSummary: "" };
  }
  const older = messages.slice(0, messages.length - window);
  const recent = messages.slice(messages.length - window);
  return { window: recent, rollingSummary: summarize(older, summaryCap) };
}

/** Naive rolling summary: join older turn lines, cap to `summaryCap` chars,
 *  keeping the most recent (tail) context when truncating. */
export function summarize(older: GroupMessage[], summaryCap = DEFAULT_SUMMARY_CAP): string {
  const joined = older.map(line).join("\n");
  if (joined.length <= summaryCap) return joined;
  return "...\n" + joined.slice(joined.length - summaryCap);
}

/** Render window messages as a channel transcript block for prompt injection. */
export function renderWindow(window: GroupMessage[]): string {
  if (window.length === 0) return "(channel empty)";
  return window.map(line).join("\n");
}
