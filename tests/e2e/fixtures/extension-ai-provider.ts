/**
 * The scripted "claude" provider behind the extension-AI e2e. It stands in for the Claude CLI
 * and the model, and nothing else: every chat turn is driven by markers in the message, reaches
 * the real `/api/ext-mcp` endpoint with the bearer token the turn was handed (as the CLI's MCP
 * client would), and judges file tools with `extensionToolDecision` — the function the real
 * provider's PreToolUse hook and `canUseTool` call for a bound session. One-shot completions are
 * scripted per prompt marker. Imported only after the fixture server has checked its isolation.
 */
import { readFileSync } from "node:fs";
import { MockProvider } from "../../../src/providers/mock-provider";
import { extensionToolDecision } from "../../../src/providers/extension-tool-policy";
import { OneShotError } from "../../../src/providers/one-shot-error";
import type { ChatEvent, ChatMessage, OneShotInput, OneShotResult, SendMessageOpts, Session, SessionConfig } from "../../../src/providers/provider.interface";

export interface TurnRecord {
  sessionId: string;
  message: string;
  extensionMcp: boolean;
  extensionPolicy: boolean;
  instructions: string | null;
  permissionMode: string | null;
  tabTools: boolean;
}
export interface ToolRecord { sessionId: string; tool: string; allowed: boolean; reason?: string; status?: number; text?: string; listed?: string[] }
export interface OneShotRecord { prompt: string; schemaInSystem: boolean; jsonSchema: boolean; model: string; aborted?: boolean }
export interface ApprovalRecord { sessionId: string; requestId: string; approved?: boolean; ms?: number }

export const records = { turns: [] as TurnRecord[], tools: [] as ToolRecord[], oneShots: [] as OneShotRecord[], approvals: [] as ApprovalRecord[] };

const SCHEMA_RETRY_MARK = "did not fit the required JSON Schema";

/** One JSON-RPC message to the turn's MCP endpoint, the way an MCP client over HTTP sends it. */
async function mcp(access: { url: string; token: string }, method: string, params: Record<string, unknown>) {
  const response = await fetch(access.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const body = await response.json().catch(() => null) as { result?: Record<string, unknown> } | null;
  return { status: response.status, result: body?.result ?? {} };
}

const textOf = (result: Record<string, unknown>) =>
  ((result.content as Array<{ type: string; text?: string }> | undefined) ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");

export class ExtensionAiScriptedProvider extends MockProvider {
  supportsExtensionBinding = true;
  private history = new Map<string, ChatMessage[]>();
  private projectPaths = new Map<string, string>();
  private approvals = new Map<string, (approved: boolean) => void>();
  private turnCount = 0;

  constructor() {
    super();
    this.id = "claude";
    this.name = "Claude";
  }

  override async createSession(config: SessionConfig): Promise<Session> {
    const session = await super.createSession(config);
    if (config.projectPath) {
      // The same object the base class keeps, so the chat service sees the project too.
      session.projectPath = config.projectPath;
      this.projectPaths.set(session.id, config.projectPath);
    }
    return session;
  }

  override async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.history.get(sessionId) ?? [];
  }

  resolveApproval(requestId: string, approved: boolean): void {
    this.approvals.get(requestId)?.(approved);
    this.approvals.delete(requestId);
  }

  override async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    await this.resumeSession(sessionId);
    const history = this.history.get(sessionId) ?? [];
    history.push({ id: crypto.randomUUID(), role: "user", content: message, timestamp: new Date().toISOString() });
    records.turns.push({
      sessionId, message, extensionMcp: !!opts?.extensionMcp, extensionPolicy: !!opts?.extensionToolPolicy,
      instructions: opts?.extensionInstructions ?? null, permissionMode: opts?.permissionMode ?? null, tabTools: !!opts?.tabToolsMcp,
    });
    yield { type: "system" as never, subtype: "init" } as never;
    const done: string[] = [];
    const policy = opts?.extensionToolPolicy;
    const cwd = this.projectPaths.get(sessionId) ?? process.cwd();

    if (message.includes("use-echo")) {
      const tool = "mcp__ppm-ext__probe_echo";
      const record: ToolRecord = { sessionId, tool, allowed: true };
      records.tools.push(record);
      const toolUseId = `tu-${crypto.randomUUID()}`;
      yield { type: "tool_use", tool, input: { text: "hello" }, toolUseId } as ChatEvent;
      const verdict = policy ? extensionToolDecision(tool, { text: "hello" }, policy, cwd) : { decision: "allow" as const };
      if (verdict.decision === "deny") Object.assign(record, { allowed: false, reason: verdict.reason });
      if (!opts?.extensionMcp) record.text = "This chat was given no ppm-ext server";
      else if (record.allowed) {
        const listed = await mcp(opts.extensionMcp, "tools/list", {});
        record.listed = ((listed.result.tools as Array<{ name: string }> | undefined) ?? []).map((t) => t.name);
        const called = await mcp(opts.extensionMcp, "tools/call", { name: "probe_echo", arguments: { text: "hello" } });
        Object.assign(record, { status: called.status, text: textOf(called.result) });
      }
      yield { type: "tool_result", output: record.text ?? record.reason ?? "", isError: !record.text?.startsWith("echo:"), toolUseId } as ChatEvent;
      done.push(`echo=${record.text ?? record.reason}`);
    }

    if (message.includes("read-files") && policy) {
      const targets = [...message.matchAll(/(read|write)=(\S+)/g)].map((m) => ({ kind: m[1]!, path: m[2]! }));
      for (const target of targets) {
        const tool = target.kind === "read" ? "Read" : "Write";
        const input = { file_path: target.path, ...(tool === "Write" ? { content: "x" } : {}) };
        const verdict = extensionToolDecision(tool, input, policy, cwd);
        const record: ToolRecord = { sessionId, tool: `${tool} ${target.path}`, allowed: verdict.decision === "allow" };
        if (verdict.decision === "deny") record.reason = verdict.reason;
        else if (tool === "Read") record.text = readFileSync(target.path, "utf8");
        records.tools.push(record);
        const toolUseId = `tu-${crypto.randomUUID()}`;
        yield { type: "tool_use", tool, input, toolUseId } as ChatEvent;
        yield { type: "tool_result", output: record.text ?? record.reason ?? "allowed", isError: !record.allowed, toolUseId } as ChatEvent;
      }
      done.push(`files=${targets.length}`);
    }

    if (message.includes("ask-approval")) {
      const requestId = crypto.randomUUID();
      const record: ApprovalRecord = { sessionId, requestId };
      records.approvals.push(record);
      const started = Date.now();
      const answer = new Promise<boolean>((resolve) => {
        this.approvals.set(requestId, resolve);
        setTimeout(() => resolve(true), 15_000).unref?.();
      });
      yield { type: "approval_request", requestId, tool: "Bash", input: { command: "echo approved" } } as ChatEvent;
      record.approved = await answer;
      record.ms = Date.now() - started;
      done.push(`approval=${record.approved ? "approved" : "denied"}`);
    }

    const text = `Turn ${++this.turnCount}: ${done.join(", ") || "nothing to do"}.`;
    yield { type: "text", content: text };
    history.push({ id: crypto.randomUUID(), role: "assistant", content: text, timestamp: new Date().toISOString() } as ChatMessage);
    this.history.set(sessionId, history);
    yield { type: "done", sessionId };
  }

  async completeOnce(input: OneShotInput): Promise<OneShotResult> {
    const record: OneShotRecord = {
      prompt: input.prompt.slice(0, 200), schemaInSystem: input.systemPrompt.includes("JSON Schema"),
      jsonSchema: !!input.jsonSchema, model: input.model,
    };
    records.oneShots.push(record);
    if (input.prompt.includes("hang")) {
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) return resolve();
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 30_000).unref?.();
      });
      record.aborted = input.signal?.aborted === true;
      throw new OneShotError("ABORTED", "The scripted call was stopped", { usage: { inputTokens: 3, outputTokens: 0 } });
    }
    // The first answer breaks the schema (score above 1), the retry fits it.
    const retried = input.prompt.includes(SCHEMA_RETRY_MARK);
    const text = retried ? `{"score": 0.5, "label": "likely"}` : `Here you go: {"score": 2, "label": "likely"}`;
    return { text, inputTokens: 10, outputTokens: 5 };
  }
}
