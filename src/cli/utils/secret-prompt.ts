import { aiChatRefusal } from "./ai-chat-refusal.ts";
import { askOnTerminal, canAskOnTerminal } from "./tty-prompt.ts";

/**
 * A secret a `ppm` settings command needs — a bot token, an access token, an MCP server's env or
 * header value — typed by a person at a terminal with the echo off. Never taken as an argument:
 * a command line lands in shell history and process lists.
 *
 * Refused from an AI chat (advisory, see `ai-chat-refusal.ts`) and without a terminal on both
 * ends (an AI's shell, a pipe, cron): there is nobody there to type it, so the person sets it in
 * PPM's Settings instead. Exits on a refusal or a cancelled prompt.
 */
export async function promptSecret(question: string, what: string, where: string): Promise<string> {
  const refusal = aiChatRefusal(what, where);
  if (refusal) exitWith(refusal);
  if (!canAskOnTerminal()) exitWith(`${what} is typed at a terminal, never passed as an argument, and this command has none. Run it in a terminal, or set it in PPM → ${where}.`);
  const typed = await askOnTerminal(question, { hidden: true });
  if (typed === null) exitWith("Cancelled; nothing was changed.");
  return typed.trim();
}

function exitWith(message: string): never {
  console.error(`\x1b[31mError:\x1b[0m ${message}`);
  process.exit(1);
}
