/**
 * Which mood the Assistant's rail robot shows (`assistant-bot-icon.tsx`). Waiting on the user
 * outranks a running turn, which outranks an open window. Pure, so it is testable without the
 * stores and the stylesheet the icon pulls in.
 */
export type AssistantBotMood = "idle" | "thinking" | "waiting" | "happy";

export function assistantBotMood(s: { waiting: number; thinking: boolean; shown: boolean }): AssistantBotMood {
  if (s.waiting > 0) return "waiting";
  if (s.thinking) return "thinking";
  return s.shown ? "happy" : "idle";
}
