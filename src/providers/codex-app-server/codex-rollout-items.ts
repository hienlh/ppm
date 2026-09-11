import type { ChatEvent } from "../provider.interface.ts";
import { redactTruncate } from "./codex-redact.ts";

/**
 * Rollout `item_completed` records → PPM chat events.
 *
 * Newer codex versions stopped writing `user_message` / `agent_message` events
 * to the rollout and write one `item_completed` per finished item instead. The
 * items are the same family the live app-server streams, but spelled
 * differently: PascalCase types (`AgentMessage`, not `agentMessage`),
 * snake_case fields (`aggregated_output`), a `command` array rather than a
 * string, and image generation arriving as a generic `Extension` carrying a
 * `kind`. Reading a rollout without this mapping yields nothing at all, which
 * is why a codex conversation displayed while it was live and came back empty
 * once it had to be read from disk.
 *
 * Kept separate from the rollout parser so the two spellings of the same item
 * family do not interleave in one function.
 */

type Item = Record<string, unknown>;

/** What a rollout item contributes to the reconstructed transcript. */
export type RolloutItemMapping =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "events"; events: ChatEvent[] }
  | { kind: "ignore" };

const IGNORED_ITEM_TYPES = new Set([
  // Reasoning is not persisted as a message anywhere else in PPM; showing it as
  // one would put the model's private notes in the transcript.
  "Reasoning",
  // Injected instructions, not part of the conversation.
  "DeveloperMessage",
]);

function textFrom(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as Item).text === "string" ? (c as Item).text as string : ""))
    .filter(Boolean)
    .join("");
}

/** `file:///C:/Users/...` → a path a person recognises. */
function plainCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== "string" || !cwd) return undefined;
  if (!cwd.startsWith("file://")) return cwd;
  try {
    const path = decodeURIComponent(new URL(cwd).pathname);
    // Windows paths come back as `/C:/…`.
    return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
  } catch {
    return cwd;
  }
}

/**
 * The command text to show. `parsed_cmd[].cmd` is the unwrapped script; the raw
 * `command` array is the interpreter plus its arguments, whose path arrives with
 * doubled backslashes on Windows.
 */
function commandText(item: Item): string {
  const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
  const parts: string[] = [];
  for (const entry of parsed) {
    const cmd = (entry as Item)?.cmd;
    if (typeof cmd === "string" && cmd.trim()) parts.push(cmd);
  }
  if (parts.length > 0) return parts.join("\n");
  if (Array.isArray(item.command)) return item.command.filter((c) => typeof c === "string").join(" ");
  return typeof item.command === "string" ? item.command : "";
}

function commandExecutionEvents(item: Item): ChatEvent[] {
  const raw = Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? "");
  const tool = /powershell|pwsh/i.test(raw) ? "PowerShell" : "Bash";
  const toolUseId = typeof item.id === "string" ? item.id : undefined;
  const exit = item.exit_code;
  return [
    { type: "tool_use", tool, input: { command: commandText(item), cwd: plainCwd(item.cwd) }, toolUseId },
    {
      type: "tool_result",
      output: redactTruncate(item.aggregated_output ?? item.stdout ?? ""),
      isError: typeof exit === "number" && exit !== 0,
      toolUseId,
    },
  ];
}

function imageGenerationEvents(item: Item): ChatEvent[] {
  const toolUseId = typeof item.id === "string" ? item.id : undefined;
  const failure = item.failure;
  return [
    {
      // `file_path` matches what the chat's image preview already looks for, and
      // `result` — the whole PNG as base64 — is deliberately dropped.
      type: "tool_use",
      tool: "ImageGen",
      input: {
        file_path: item.savedPath ?? null,
        prompt: item.revisedPrompt ?? null,
        transparentBackground: item.transparentBackground ?? false,
      },
      toolUseId,
    },
    {
      type: "tool_result",
      output: failure != null ? redactTruncate(failure) : String(item.savedPath ?? "generated"),
      isError: failure != null,
      toolUseId,
    },
  ];
}

/** Everything the mapping does not know, shown rather than silently dropped. */
function genericEvents(item: Item): ChatEvent[] {
  const toolUseId = typeof item.id === "string" ? item.id : undefined;
  // A base64 payload would otherwise land in the transcript whole.
  const { result: _result, ...rest } = item;
  return [{ type: "tool_use", tool: String(item.type ?? "tool"), input: rest, toolUseId }];
}

export function mapRolloutItem(item: unknown): RolloutItemMapping {
  if (!item || typeof item !== "object") return { kind: "ignore" };
  const it = item as Item;
  const type = typeof it.type === "string" ? it.type : "";

  if (IGNORED_ITEM_TYPES.has(type)) return { kind: "ignore" };
  if (type === "UserMessage") {
    const text = textFrom(it.content);
    return text ? { kind: "user", text } : { kind: "ignore" };
  }
  if (type === "AgentMessage") {
    const text = textFrom(it.content);
    return text ? { kind: "assistant", text } : { kind: "ignore" };
  }
  if (type === "CommandExecution") return { kind: "events", events: commandExecutionEvents(it) };
  if (type === "Extension") {
    // `kind` names the extension; image generation is the one PPM renders specially.
    if (String(it.kind ?? "").startsWith("image_gen")) {
      return { kind: "events", events: imageGenerationEvents(it) };
    }
    return { kind: "events", events: genericEvents(it) };
  }
  return { kind: "events", events: genericEvents(it) };
}
