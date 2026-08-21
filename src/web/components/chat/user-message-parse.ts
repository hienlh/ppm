/**
 * Parsing for stored user-message content.
 *
 * What lands in the transcript is not what the user typed: the composer and the
 * runtime wrap it with attachment markers, slash-command tags, an agent
 * delegation prefix, and IDE/system context tags. Both the transcript bubble and
 * the composer's history recall need the same decomposition, so it lives here.
 */

export interface SystemTag {
  name: string;
  label: string;
  content: string;
}

export interface SlashCommand {
  name: string;
  args?: string;
}

const TAG_LABELS: Record<string, string> = {
  "system-reminder": "Context",
  claudeMd: "CLAUDE.md",
  gitStatus: "Git Status",
  currentDate: "Date",
  fast_mode_info: "Fast Mode",
  "available-deferred-tools": "Tools",
  "task-notification": "Task Result",
  environment_details: "Environment",
  "local-command-caveat": "System",
};

/** Extract system-injected XML tags into structured objects + clean text */
export function extractSystemTags(text: string): { cleanText: string; tags: SystemTag[] } {
  const tags: SystemTag[] = [];
  const tagPattern = /<(system-reminder|available-deferred-tools|antml:[\w-]+|fast_mode_info|claudeMd|gitStatus|currentDate|task-notification|environment_details|local-command-caveat)[^>]*>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = tagPattern.exec(text)) !== null) {
    const name = match[1]!;
    tags.push({
      name,
      label: TAG_LABELS[name] ?? name.replace(/^antml:/, "").replace(/-/g, " "),
      content: match[2]!.trim(),
    });
  }
  const cleanText = text.replace(tagPattern, "").trim();
  return { cleanText, tags };
}

/** Extract slash command tags from user message content */
export function parseCommandTags(text: string): { command: SlashCommand | null; cleanText: string } {
  const nameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (!nameMatch) return { command: null, cleanText: text };
  const name = nameMatch[1]!.trim();
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = argsMatch?.[1]?.trim() || undefined;
  // Strip all command tags regardless of order
  const cleanText = text
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .trim();
  return { command: { name, args }, cleanText };
}

/** Detect the leading "Use the <agent> agent to" delegation prompt, split off as a chip */
export function parseAgentTag(text: string): { agent: string | null; cleanText: string } {
  const m = text.match(/^Use the (\S+) agent to\s?/);
  if (!m) return { agent: null, cleanText: text };
  return { agent: m[1]!, cleanText: text.slice(m[0].length) };
}

/** Extract the IDE-injected <ide_opened_file> context tag — returns the open file path + cleaned text */
export function parseIdeOpenedFile(text: string): { idePath: string | null; cleanText: string } {
  const tagRe = /<ide_opened_file>([\s\S]*?)<\/ide_opened_file>/g;
  const m = tagRe.exec(text);
  if (!m) return { idePath: null, cleanText: text };
  // Inner format: "The user opened the file <path> in the IDE. ..."
  const pathMatch = m[1]!.match(/opened the file (.+?) in the IDE/);
  const idePath = pathMatch?.[1]?.trim() ?? null;
  const cleanText = text.replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "").trim();
  return { idePath, cleanText };
}

/** Parse user message content, extracting attached file paths and the actual text */
export function parseUserAttachments(content: string): { files: string[]; text: string } {
  // Match: [Attached file: /path] or [Attached files:\n/path1\n/path2\n]
  // Trailing newlines are optional — an attachment-only message has the marker
  // trimmed to the end of the string (extractTerminalBlocks trims), so the
  // separator newlines may be absent.
  const singleMatch = content.match(/^\[Attached file: (.+?)\]\n*/);
  if (singleMatch) {
    return { files: [singleMatch[1]!], text: content.slice(singleMatch[0].length) };
  }

  const multiMatch = content.match(/^\[Attached files:\n([\s\S]+?)\]\n*/);
  if (multiMatch) {
    const files = multiMatch[1]!.split("\n").map((l) => l.trim()).filter(Boolean);
    return { files, text: content.slice(multiMatch[0].length) };
  }

  return { files: [], text: content };
}

/** Extract leading terminal code fences from message text */
export function extractTerminalBlocks(text: string): { blocks: string[]; remainingText: string } {
  const blocks: string[] = [];
  let remaining = text;
  const re = /^```(?:bash|sh|shell|zsh)\n([\s\S]*?)\n```\s*(?:\n\n?)?/;
  let match;
  while ((match = remaining.match(re)) !== null) {
    blocks.push(match[1]!);
    remaining = remaining.slice(match[0].length);
  }
  return { blocks, remainingText: remaining.trim() };
}

export interface ParsedUserMessage {
  files: string[];
  /** Body text with the slash-command args folded in, for transcript display */
  text: string;
  /** Body text alone, with the command args kept separate — for recomposing input */
  body: string;
  tags: SystemTag[];
  command: SlashCommand | null;
  terminalBlocks: string[];
  idePath: string | null;
  agent: string | null;
}

/** Full decomposition of a stored user message, outermost wrapper first. */
export function parseUserMessage(content: string): ParsedUserMessage {
  const { idePath, cleanText: afterIde } = parseIdeOpenedFile(content);
  const { blocks, remainingText: afterBlocks } = extractTerminalBlocks(afterIde);
  const parsed = parseUserAttachments(afterBlocks);
  // Strip local-command-stdout/stderr tags but keep their content as plain text
  const withoutCmdOutput = parsed.text
    .replace(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/g, "$1");
  const { cleanText: noSysTags, tags } = extractSystemTags(withoutCmdOutput);
  const { command, cleanText } = parseCommandTags(noSysTags);
  const { agent, cleanText: body } = parseAgentTag(cleanText);
  const text = command?.args ? (body ? `${command.args}\n\n${body}` : command.args) : body;
  return { files: parsed.files, text, body, tags, command, terminalBlocks: blocks, idePath, agent };
}

/**
 * Rebuild what the user originally typed, for prefilling the composer on history
 * recall. Attachments, terminal blocks, and injected context are dropped — they
 * cannot be re-attached from a keystroke — while a slash command is restored to
 * its typed `/name args` form and the agent comes back as a chip.
 */
export function toComposerDraft(content: string): { agent: string | null; text: string } {
  const { agent, body, command } = parseUserMessage(content);
  if (!command) return { agent, text: body };
  // Stored names appear both with and without the leading slash — normalise to one.
  const name = command.name.replace(/^\/+/, "");
  const typed = `/${name}${command.args ? ` ${command.args}` : ""}`;
  return { agent, text: body ? `${typed}\n\n${body}` : typed };
}
