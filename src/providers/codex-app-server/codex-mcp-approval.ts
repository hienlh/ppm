/**
 * Codex asking whether an MCP tool may run, recognised so a PPM Assistant session can show it as
 * an approval card. Every tool of the servers in Settings → PPM Assistant asks
 * (`default_tools_approval_mode: "prompt"`), and codex 0.161 delivers the question in one of two
 * shapes depending on its `tool_call_mcp_elicitation` feature, which the session turns on:
 *  - `mcpServer/elicitation/request`, a form with no fields whose `_meta.codex_approval_kind`
 *    is `mcp_tool_call`, answered with `accept` / `decline` / `cancel`;
 *  - `item/tool/requestUserInput` with one question whose id starts `mcp_tool_call_approval`,
 *    answered by picking one of its options ("Allow", "Allow for this session", "Allow and don't
 *    ask me again", "Cancel").
 * The card offers allow or deny, nothing more: an "allow for the session" or "always" answer is
 * never sent, so every call asks again. An ordinary session never comes here.
 */

export type CodexMcpApproval =
  | { shape: "elicitation"; tool: string; input: Record<string, unknown> }
  | { shape: "question"; tool: string; input: Record<string, unknown>; questionId: string; allow: string; deny: string | null };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const APPROVAL_QUESTION_PREFIX = "mcp_tool_call_approval";

/** `mcp__<server>__<tool>`, the label Claude's cards use for the same kind of call. */
function toolLabel(server: string, tool: string | undefined): string {
  return tool ? `mcp__${server}__${tool}` : `mcp__${server}`;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** A form whose schema asks for nothing: what a yes/no approval looks like as an elicitation. */
function asksForNothing(schema: unknown): boolean {
  if (!isRecord(schema)) return true;
  const properties = schema.properties;
  return !isRecord(properties) || Object.keys(properties).length === 0;
}

/** The approval this server request carries, or null when it is anything else. */
export function codexMcpApproval(method: string, params: unknown): CodexMcpApproval | null {
  if (!isRecord(params)) return null;
  if (method === "mcpServer/elicitation/request") {
    const server = typeof params.serverName === "string" ? params.serverName : "";
    const meta = isRecord(params._meta) ? params._meta : {};
    const kind = meta.codex_approval_kind;
    const approval = typeof kind === "string"
      ? kind.startsWith("mcp_tool_call")
      : params.mode === "form" && asksForNothing(params.requestedSchema);
    if (!server || !approval) return null;
    const tool = stringField(meta, "tool_name", "tool_title");
    return {
      shape: "elicitation",
      tool: toolLabel(server, tool),
      input: {
        server,
        ...(tool ? { tool } : {}),
        ...(typeof params.message === "string" ? { message: params.message } : {}),
        ...(meta.tool_params !== undefined ? { arguments: meta.tool_params } : {}),
      },
    };
  }
  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const question = questions.find((q) => isRecord(q) && typeof q.id === "string" && q.id.startsWith(APPROVAL_QUESTION_PREFIX));
    if (!isRecord(question) || questions.length !== 1) return null;
    const labels = (Array.isArray(question.options) ? question.options : [])
      .map((o) => (isRecord(o) && typeof o.label === "string" ? o.label : ""))
      .filter(Boolean);
    const allow = labels.find((l) => l === "Allow") ?? labels.find((l) => /^allow$/i.test(l.trim()));
    if (!allow) return null;
    const deny = labels.find((l) => /^(cancel|decline|deny)$/i.test(l.trim())) ?? null;
    const text = [question.header, question.question].filter((t) => typeof t === "string" && t).join(" — ");
    // The question names the server and tool only in its wording; read them when it does.
    const server = /\b([A-Za-z0-9_-]+) MCP server\b/.exec(text)?.[1];
    const tool = /\btool ["“']([A-Za-z0-9_.:-]+)["”']/.exec(text)?.[1];
    return {
      shape: "question",
      tool: server ? toolLabel(server, tool) : "MCP tool",
      input: { ...(text ? { message: text } : {}) },
      questionId: question.id as string,
      allow,
      deny,
    };
  }
  return null;
}

/** Codex's answer to an approval: only ever a one-time allow, a decline, or a cancel. */
export function codexMcpApprovalResponse(approval: CodexMcpApproval, approved: boolean, aborted = false): unknown {
  if (approval.shape === "elicitation") {
    return { action: approved ? "accept" : aborted ? "cancel" : "decline", content: approved ? {} : null, _meta: null };
  }
  const answer = approved ? approval.allow : approval.deny;
  return { answers: { [approval.questionId]: { answers: answer ? [answer] : [] } } };
}
