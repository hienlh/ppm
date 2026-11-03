/**
 * What the chat search index stores for one message, split into the two columns of the FTS
 * table: `text`, what the person typed and what the assistant answered; and `tool_text`, the tool
 * calls — names, arguments, output and errors, nested agent steps included.
 *
 * The split exists for the AI's own search (`search_sessions`), which matches and quotes `text`
 * alone: tool output is where secrets, tokens and logs land, and none of it may come back through
 * a snippet. The chat's search box still matches both.
 */
import { decodeMessageBlocks } from "../shared/chat-message-blocks.ts";
import type { ChatEvent, ChatMessage } from "../types/chat.ts";

/** Per-event cap on indexed tool output. A single `Read`/`grep` result can be
 *  hundreds of KB; indexing all of it bloats the FTS store far more than it
 *  helps, since matches that deep are rarely what someone is looking for. */
const EVENT_TEXT_CAP = 4000;

/**
 * Per-column cap, which the per-event one does not imply.
 *
 * `EVENT_TEXT_CAP` bounds each event and nothing bounds how many there are. One
 * agent turn is routinely hundreds of tool calls, each with children that
 * recurse through the same collector — so a single turn could contribute a
 * multi-megabyte FTS row, for a feature whose output is a twelve-token snippet.
 * The cap is generous on purpose: this is about the tail, not about trimming
 * ordinary messages.
 */
export const MESSAGE_TEXT_CAP = 64_000;

export interface MessageSearchColumns {
  text: string;
  toolText: string;
}

function stringifyToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.slice(0, EVENT_TEXT_CAP);
  try {
    return JSON.stringify(input).slice(0, EVENT_TEXT_CAP);
  } catch {
    return "";
  }
}

/** Push as much of `text` as the budget allows; answer with what remains. */
function take(text: string | undefined, out: string[], budget: number): number {
  if (!text || budget <= 0) return budget;
  out.push(text.length <= budget ? text : text.slice(0, budget));
  return budget - Math.min(text.length, budget);
}

/**
 * Appends a tool-side event's text to `out` until the budget runs out, and reports what is left.
 *
 * The budget is threaded through rather than applied to the joined result so a
 * turn with a thousand tool calls stops *collecting* — building the array and
 * then slicing it is the same allocation this is meant to avoid.
 */
function collectToolText(events: ChatEvent[] | undefined, out: string[], budget: number, nested: boolean): number {
  if (!events) return budget;
  for (const ev of events) {
    if (budget <= 0) return 0;
    switch (ev.type) {
      case "text":
        // A top-level reply is prose (the `text` column); one inside an agent's steps is not.
        if (nested || ev.parentToolUseId) budget = take(ev.content, out, budget);
        break;
      case "tool_use":
        // The tool name and its arguments are what a search for "the commit
        // where I opened PR 10232" actually has to match.
        budget = take(ev.tool, out, budget);
        budget = take(stringifyToolInput(ev.input), out, budget);
        budget = collectToolText(ev.children, out, budget, true);
        break;
      case "tool_result":
        budget = take(ev.output.slice(0, EVENT_TEXT_CAP), out, budget);
        break;
      case "error":
        budget = take(ev.message, out, budget);
        break;
      // `thinking` is deliberately skipped: it is the model's scratch work, it
      // is bulky, and a snippet drawn from it reads as noise in the results.
      default:
        break;
    }
  }
  return budget;
}

/** The message's prose: its body without PPM's blocks, else its top-level reply events. */
function proseOf(msg: ChatMessage): string[] {
  const body = msg.content ? decodeMessageBlocks(msg.content).content : "";
  if (body.trim()) return [body];
  return (msg.events ?? [])
    .filter((ev): ev is Extract<ChatEvent, { type: "text" }> => ev.type === "text" && !ev.parentToolUseId)
    .map((ev) => ev.content);
}

const joinCapped = (parts: string[]): string =>
  parts.filter((p) => p && p.trim()).join("\n").trim().slice(0, MESSAGE_TEXT_CAP);

/**
 * Both columns for one normalized message.
 *
 * `content` alone misses most of a transcript: `getMessages` merges tool calls
 * and their results into `events` and leaves `content` empty for any turn that
 * only used tools — the commit-and-open-a-PR turns are exactly those, so they
 * must still be findable from the chat's search box.
 */
export function messageSearchColumns(msg: ChatMessage): MessageSearchColumns {
  const prose: string[] = [];
  let budget = MESSAGE_TEXT_CAP;
  for (const part of proseOf(msg)) budget = take(part, prose, budget);
  const tools: string[] = [];
  collectToolText(msg.events, tools, MESSAGE_TEXT_CAP, false);
  return { text: joinCapped(prose), toolText: joinCapped(tools) };
}

/** Everything searchable in one message, both columns, as the chat's search box matches it. */
export function messageSearchText(msg: ChatMessage): string {
  const { text, toolText } = messageSearchColumns(msg);
  return joinCapped([text, toolText]);
}
