/**
 * The mark an AI chat's processes carry, so `ppm db` can tell an AI from a person.
 *
 * Every chat provider sets it on the process it starts — the Claude CLI, `codex app-server`,
 * `cursor-agent` — and each command those run in their shell inherits it. `ppm db` then hides
 * the connections whose "Available to the AI chat" is off, and refuses to open them. PPM's own
 * terminal takes the mark out again, so a PPM that was itself started from a chat still gives a
 * person every connection.
 *
 * A guard against mistakes, not a security boundary: anything in the chat's shell can unset it,
 * and nothing stops a person from typing the same command in a terminal.
 */
export const AI_CHAT_ENV = "PPM_AI_CHAT";

/** What a chat provider adds to the environment of the process it starts. */
export const AI_CHAT_MARK: Readonly<Record<string, string>> = { [AI_CHAT_ENV]: "1" };

/** Whether this process was started from an AI chat. */
export function inAiChat(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[AI_CHAT_ENV];
  return !!value && value !== "0";
}

/** `env` without the mark, for a process a person types into. */
export function withoutAiChatMark<T extends Record<string, string | undefined>>(env: T): T {
  const { [AI_CHAT_ENV]: _mark, ...rest } = env;
  return rest as T;
}
