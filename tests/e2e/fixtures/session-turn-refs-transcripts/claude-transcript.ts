/**
 * A synthetic Claude Code transcript in the record shapes the CLI writes: prompts carrying their
 * `promptId`, assistant records sharing one `message.id` per reply, tool results stamped with the
 * prompt's id, `isMeta` continues, task notifications, inline images and `compact_boundary` +
 * compaction summary pairs. Every record is chained through `parentUuid`, the way the SDK walks
 * the file back from its newest record. No real conversation content.
 */
import { randomUUID } from "node:crypto";

const VERSION = "2.1.280";

export interface ClaudeTurnSpec {
  promptId: string;
  prompt: string;
  answer: string;
  /** An image attached to the prompt: its upload path and base64 PNG. */
  image?: { path: string; data: string };
  /** One tool call the turn makes, with the raw output its result carries. */
  tool?: { id: string; name: string; input: Record<string, unknown>; output: string };
  /** A task notification after the answer, stamped with this turn's prompt id (not a prompt). */
  taskNotification?: boolean;
  /** The CLI's own `isMeta` continue, inside the turn (not a prompt). */
  metaContinue?: boolean;
  /** Minutes after the transcript's start. */
  minute: number;
}

/** Appends records to one session's transcript, chained the way Claude Code chains them. */
export class ClaudeTranscript {
  readonly lines: string[] = [];
  private parent: string | null = null;

  constructor(readonly sessionId: string, readonly cwd: string, private readonly start: number) {}

  private base(minute: number, second = 0) {
    return {
      userType: "external", entrypoint: "sdk-ts", cwd: this.cwd, sessionId: this.sessionId,
      version: VERSION, gitBranch: "main", timestamp: new Date(this.start + minute * 60_000 + second * 1000).toISOString(),
    };
  }

  private push(record: Record<string, unknown>, chained = true): string {
    const uuid = (record.uuid as string) ?? randomUUID();
    const full = chained ? { parentUuid: this.parent, isSidechain: false, ...record, uuid } : { ...record, uuid };
    this.lines.push(JSON.stringify(full));
    if (chained) this.parent = uuid;
    return uuid;
  }

  /** A prompt the person sent; an empty `promptId` writes one without (older CLIs, local commands). */
  prompt(promptId: string, text: string, minute: number, image?: ClaudeTurnSpec["image"], uuid?: string): string {
    const content = image
      ? [
        { type: "image", source: { type: "base64", media_type: "image/png", data: image.data } },
        { type: "text", text: `[Attached image (contents included in this message): ${image.path}]\n\n${text}` },
      ]
      : text;
    return this.push({
      ...(promptId ? { promptId } : {}), type: "user", message: { role: "user", content }, ...(uuid ? { uuid } : {}),
      permissionMode: "bypassPermissions", promptSource: "sdk", turnOrigin: "sdk", ...this.base(minute),
    });
  }

  assistantText(text: string, minute: number, second = 30): string {
    const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    return this.push({
      message: {
        model: "claude-opus-5", id, type: "message", role: "assistant", content: [{ type: "text", text }],
        stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 40 },
      },
      requestId: `req_${randomUUID().slice(0, 12)}`, type: "assistant", ...this.base(minute, second),
    });
  }

  toolCall(promptId: string, tool: NonNullable<ClaudeTurnSpec["tool"]>, minute: number): void {
    const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const assistantUuid = this.push({
      message: {
        model: "claude-opus-5", id, type: "message", role: "assistant",
        content: [{ type: "tool_use", id: tool.id, name: tool.name, input: tool.input }],
        stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 },
      },
      requestId: `req_${randomUUID().slice(0, 12)}`, type: "assistant", ...this.base(minute, 10),
    });
    this.push({
      promptId, type: "user",
      message: { role: "user", content: [{ tool_use_id: tool.id, type: "tool_result", content: tool.output, is_error: false }] },
      toolUseResult: { stdout: tool.output, stderr: "", interrupted: false, isImage: false },
      sourceToolAssistantUUID: assistantUuid, ...this.base(minute, 15),
    });
  }

  turn(spec: ClaudeTurnSpec): void {
    this.prompt(spec.promptId, spec.prompt, spec.minute, spec.image);
    if (spec.tool) this.toolCall(spec.promptId, spec.tool, spec.minute);
    if (spec.metaContinue) {
      this.push({
        promptId: spec.promptId, type: "user", isMeta: true,
        message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] }, ...this.base(spec.minute, 20),
      });
    }
    this.assistantText(spec.answer, spec.minute);
    if (spec.taskNotification) {
      this.push({
        promptId: spec.promptId, type: "user", promptSource: "system", turnOrigin: "task_notification", origin: { kind: "task-notification" },
        message: { role: "user", content: "<task-notification><task-id>bg1</task-id><status>completed</status><summary>Background check finished</summary></task-notification>" },
        ...this.base(spec.minute, 40),
      });
    }
  }

  /**
   * A compaction: the boundary (parentless, pointing back logically) and the summary the next
   * segment hangs off. `jsonlPath` is the transcript itself, which the summary tells the reader to open.
   */
  compaction(jsonlPath: string, minute: number, summaryExtra = ""): void {
    const logicalParentUuid = this.parent;
    this.parent = null;
    this.push({
      logicalParentUuid, type: "system", subtype: "compact_boundary", content: "Conversation compacted", isMeta: false, level: "info",
      compactMetadata: { trigger: "auto", preTokens: 180_000 }, ...this.base(minute),
    });
    this.push({
      type: "user", isVisibleInTranscriptOnly: true, isCompactSummary: true,
      message: {
        role: "user",
        content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier part of the conversation.\n\n"
          + `Summary: the person and the assistant worked through a long refactor.${summaryExtra}\n\n`
          + `If you need specific details from before compaction, read the full transcript at: ${jsonlPath}`,
      },
      ...this.base(minute, 5),
    });
  }

  toString(): string {
    return this.lines.map((l) => `${l}\n`).join("");
  }
}
