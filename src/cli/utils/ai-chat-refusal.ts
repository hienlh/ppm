import { inAiChat } from "../../services/ai-chat-env.ts";

/**
 * The one wording every settings command uses when it will not run from an AI chat: what it
 * changes can expose PPM or the user's accounts, or persist access, so a person makes that change.
 *
 * Advisory only. It keys on the AI-chat mark in the environment, which a command can drop; the
 * real control is the shell card the user answers before the command runs at all. A person at
 * their own terminal is never refused here.
 */
export function aiChatRefusalText(what: string, where: string): string {
  return `${what} is changed in PPM → ${where}; refused here from an AI chat (it may expose or persist access). Give the user the command, or ask them to change it there.`;
}

/** The refusal when this command runs from an AI chat, else null. */
export function aiChatRefusal(what: string, where: string): string | null {
  return inAiChat() ? aiChatRefusalText(what, where) : null;
}

/** Exits with the refusal when run from an AI chat; returns otherwise. */
export function refuseInAiChat(what: string, where: string): void {
  const refusal = aiChatRefusal(what, where);
  if (!refusal) return;
  console.error(`\x1b[31mError:\x1b[0m ${refusal}`);
  process.exit(1);
}
