/**
 * Codex asks before an MCP tool runs, and in a PPM Assistant session that question becomes the
 * chat's approval card, answered allow or deny — never "allow for the session" or "always", so
 * every call asks again. An ordinary session declines it as it always has.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { codexMcpApproval, codexMcpApprovalResponse } from "../../../src/providers/codex-app-server/codex-mcp-approval.ts";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { CodexJsonRpcClient } from "../../../src/providers/codex-app-server/codex-jsonrpc-client.ts";
import * as accounts from "../../../src/services/codex-account.service.ts";
import { configService } from "../../../src/services/config.service.ts";

const ELICITATION = {
  threadId: "t", turnId: "u", serverName: "github", mode: "form",
  _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_title: "create_issue", tool_params: { title: "x" } },
  message: "Allow the github MCP server to run tool \"create_issue\"?",
  requestedSchema: { type: "object", properties: {} },
};
const QUESTION = {
  threadId: "t", turnId: "u", itemId: "i", isBlocking: true, autoResolutionMs: null,
  questions: [{
    id: "mcp_tool_call_approval_call1", header: "Approve app tool call?", isOther: false, isSecret: false,
    question: "Allow the github MCP server to run tool \"create_issue\"?",
    options: [{ label: "Allow" }, { label: "Allow for this session" }, { label: "Allow and don't ask me again" }, { label: "Cancel" }],
  }],
};

describe("recognising an MCP tool approval", () => {
  it("reads an approval elicitation and answers it once, allow or decline", () => {
    const approval = codexMcpApproval("mcpServer/elicitation/request", ELICITATION)!;
    expect(approval.tool).toBe("mcp__github__create_issue");
    expect(approval.input).toMatchObject({ server: "github", tool: "create_issue", arguments: { title: "x" } });
    expect(codexMcpApprovalResponse(approval, true)).toEqual({ action: "accept", content: {}, _meta: null });
    expect(codexMcpApprovalResponse(approval, false)).toEqual({ action: "decline", content: null, _meta: null });
    expect(codexMcpApprovalResponse(approval, false, true)).toEqual({ action: "cancel", content: null, _meta: null });
  });

  it("reads the request_user_input form and never picks a remembering option", () => {
    const approval = codexMcpApproval("item/tool/requestUserInput", QUESTION)!;
    expect(approval.tool).toBe("mcp__github__create_issue");
    expect(codexMcpApprovalResponse(approval, true)).toEqual({ answers: { mcp_tool_call_approval_call1: { answers: ["Allow"] } } });
    expect(codexMcpApprovalResponse(approval, false)).toEqual({ answers: { mcp_tool_call_approval_call1: { answers: ["Cancel"] } } });
  });

  it("leaves everything else alone: data forms, other questions, other requests", () => {
    expect(codexMcpApproval("mcpServer/elicitation/request", {
      ...ELICITATION, _meta: null, requestedSchema: { type: "object", properties: { email: { type: "string" } } },
    })).toBeNull();
    expect(codexMcpApproval("item/tool/requestUserInput", { ...QUESTION, questions: [{ ...QUESTION.questions[0], id: "pick_color" }] })).toBeNull();
    expect(codexMcpApproval("item/commandExecution/requestApproval", { command: "ls" })).toBeNull();
    expect(codexMcpApproval("mcpServer/elicitation/request", null)).toBeNull();
  });
});

describe("Codex provider", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  let provider: CodexAppServerProvider;
  let responses: Array<{ id: unknown; result?: unknown; error?: string }>;
  let previousAi: ReturnType<typeof configService.get<"ai">>;

  beforeEach(() => {
    provider = new CodexAppServerProvider();
    responses = [];
    previousAi = configService.get("ai");
    configService.set("ai", { ...previousAi, providers: { ...previousAi.providers, codex: { type: "cli", cli_command: "codex" } } });
    spies.push(spyOn(accounts, "resolveCodexAccountForSession").mockResolvedValue(null));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "notify").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "close").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "respond").mockImplementation((id: any, result: any) => { responses.push({ id, result }); }));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "respondError").mockImplementation((id: any, error: any) => { responses.push({ id, error }); }));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "request").mockImplementation(async (method: string) => {
      if (method === "config/read") return { config: {} };
      if (method === "thread/start") return { thread: { id: `thread-${crypto.randomUUID()}` } };
      return {};
    }));
  });
  afterEach(() => {
    provider.cleanupAll();
    configService.set("ai", previousAi);
    spies.splice(0).forEach((s) => s.mockRestore());
  });

  async function live(opts: Record<string, unknown>) {
    const session = await (provider as any).connect((await provider.createSession({})).id, opts);
    const pushed: any[] = [];
    session.channel.push = (event: unknown) => { pushed.push(event); };
    return { session, pushed };
  }

  it("shows an Assistant session's MCP approval as a card and answers it with the user's choice", async () => {
    const { session, pushed } = await live({ assistantSession: true, assistantInstructions: "# PPM Assistant" });
    (provider as any).handleServerRequest(session, { id: 7, method: "mcpServer/elicitation/request", params: ELICITATION });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ type: "approval_request", tool: "mcp__github__create_issue" });
    provider.resolveApproval(pushed[0].requestId, true);
    expect(responses).toEqual([{ id: 7, result: { action: "accept", content: {}, _meta: null } }]);

    (provider as any).handleServerRequest(session, { id: 8, method: "item/tool/requestUserInput", params: QUESTION });
    provider.resolveApproval(pushed[1].requestId, false);
    expect(responses[1]).toEqual({ id: 8, result: { answers: { mcp_tool_call_approval_call1: { answers: ["Cancel"] } } } });
  });

  it("cancels a waiting MCP approval when the session stops", async () => {
    const { session } = await live({ assistantSession: true, assistantInstructions: "# PPM Assistant" });
    (provider as any).handleServerRequest(session, { id: 9, method: "mcpServer/elicitation/request", params: ELICITATION });
    (provider as any).declinePending(session);
    expect(responses).toEqual([{ id: 9, result: { action: "cancel", content: null, _meta: null } }]);
  });

  it("declines the same elicitation in an ordinary session, as before", async () => {
    const { session, pushed } = await live({ permissionMode: "default" });
    (provider as any).handleServerRequest(session, { id: 10, method: "mcpServer/elicitation/request", params: ELICITATION });
    expect(pushed).toHaveLength(0);
    expect(responses).toEqual([{ id: 10, error: "unsupported server request" }]);
  });
});
