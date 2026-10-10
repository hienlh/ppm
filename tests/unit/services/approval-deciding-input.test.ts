/**
 * The deciding part of a card is what a person approves away from the chat that asked, so it
 * must be everything that will run, exactly as it will run: shell metacharacters kept, file
 * content and edits shown, an MCP call's arguments shown, an Assistant card's body in full —
 * and a card that cannot show all of it (a Codex patch, a value a provider capped) says so.
 */
import { describe, expect, it } from "bun:test";
import { decidingInput } from "../../../src/services/chat-control/approval-deciding-input.ts";
import { approvalInput } from "../../../src/providers/codex-app-server/codex-approval-input.ts";
import { codexMcpApproval } from "../../../src/providers/codex-app-server/codex-mcp-approval.ts";
import { redactFields } from "../../../src/providers/codex-app-server/codex-redact.ts";

describe("commands", () => {
  it("keeps redirections, backticks and substitutions exactly as they run", () => {
    for (const command of ["echo x > ~/.bashrc", "cat < /etc/passwd", "echo `id`", "rm -rf $(pwd)/..", "a && b | c 2>&1"]) {
      const d = decidingInput({ tool: "Bash", input: { command, description: "harmless, trust me" } });
      expect(d).toMatchObject({ kind: "command", title: "Bash", text: command, lang: "bash", complete: true });
      // What the agent says about its own command is not part of the decision.
      expect(JSON.stringify(d)).not.toContain("trust me");
    }
  });

  it("shows a Codex command with the folder it runs in", () => {
    const input = approvalInput("item/commandExecution/requestApproval", { command: "bash -lc 'echo hi > out.txt'", commandActions: [{ command: "echo hi > out.txt" }], cwd: "/repo" });
    const d = decidingInput({ tool: "Bash", input });
    expect(d.text).toBe("echo hi > out.txt");
    expect(d.facts).toEqual([{ label: "Folder", value: "/repo" }]);
    expect(d.complete).toBe(true);
  });

  it("is incomplete when the provider capped the command", () => {
    const input = redactFields({ command: "x".repeat(9000) });
    const d = decidingInput({ tool: "PowerShell", input });
    expect(d.complete).toBe(false);
    expect(d.incompleteReason).toContain("cut short");
  });

  it("makes hidden and reordering characters visible instead of dropping them", () => {
    const d = decidingInput({ tool: "Bash", input: { command: "echo safe‮; rm -rf /​" } });
    expect(d.text).toBe("echo safe⟨U+202E⟩; rm -rf /⟨U+200B⟩");
  });
});

describe("files", () => {
  it("shows a write's full content and path", () => {
    const content = "line <1>\n`two`\n".repeat(2000);
    const d = decidingInput({ tool: "Write", input: { file_path: "/a/b.ts", content } });
    expect(d).toMatchObject({ kind: "write", text: content, complete: true });
    expect(d.facts).toEqual([{ label: "File", value: "/a/b.ts" }]);
  });

  it("shows every replacement of an edit, old and new marked line by line", () => {
    const one = decidingInput({ tool: "Edit", input: { file_path: "/f", old_string: "a\nb", new_string: "c", replace_all: true } });
    expect(one).toMatchObject({ kind: "edit", lang: "diff", complete: true, text: "-a\n-b\n+c" });
    expect(one.facts).toContainEqual({ label: "Replaces", value: "every occurrence" });
    const many = decidingInput({ tool: "MultiEdit", input: { file_path: "/f", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q" }] } });
    expect(many.text).toBe("@@ edit 1 of 2 @@\n-x\n+y\n@@ edit 2 of 2 @@\n-p\n+q");
  });

  it("is incomplete when an edit's text is missing", () => {
    expect(decidingInput({ tool: "Edit", input: { file_path: "/f", old_string: "a" } }).complete).toBe(false);
    expect(decidingInput({ tool: "Write", input: { file_path: "/f" } }).complete).toBe(false);
  });

  it("shows a notebook cell and its new source", () => {
    const d = decidingInput({ tool: "NotebookEdit", input: { notebook_path: "/n.ipynb", cell_id: "c1", new_source: "print(1)", edit_mode: "replace" } });
    expect(d).toMatchObject({ kind: "notebook", text: "print(1)", complete: true });
    expect(d.facts.map((f) => f.label)).toEqual(["Notebook", "Cell", "Change"]);
  });

  it("never calls a Codex patch complete: its diff is not in the request", () => {
    const input = approvalInput("applyPatchApproval", { fileChanges: { "/r/a.ts": { update: { unified_diff: "@@" } } }, reason: "fix" });
    const d = decidingInput({ tool: "Edit", input });
    expect(d).toMatchObject({ kind: "patch", complete: false });
    expect(d.facts).toContainEqual({ label: "Files", value: "/r/a.ts" });
    expect(d.incompleteReason).toContain("not part of this request");
    // The current protocol names no file at all.
    expect(decidingInput({ tool: "Edit", input: approvalInput("item/fileChange/requestApproval", {}) }).complete).toBe(false);
  });
});

describe("web, MCP and other tools", () => {
  it("shows a fetch's URL and prompt, a search's query", () => {
    expect(decidingInput({ tool: "WebFetch", input: { url: "https://x.test/?q=<a>", prompt: "summarise" } }))
      .toMatchObject({ kind: "web", facts: [{ label: "URL", value: "https://x.test/?q=<a>" }], text: "summarise", complete: true });
    expect(decidingInput({ tool: "WebSearch", input: { query: "ppm", blocked_domains: ["a.test"] } }))
      .toMatchObject({ text: "ppm", facts: [{ label: "Never these sites", value: "a.test" }] });
  });

  it("shows an MCP call's whole arguments as formatted JSON", () => {
    const approval = codexMcpApproval("mcpServer/elicitation/request", {
      serverName: "github", mode: "form",
      _meta: { codex_approval_kind: "mcp_tool_call", tool_title: "create_issue", tool_params: { title: "x > y", body: "`z`" } },
      message: "?", requestedSchema: { type: "object", properties: {} },
    })!;
    const d = decidingInput({ tool: approval.tool, input: redactFields(approval.input) });
    expect(d).toMatchObject({ kind: "tool", lang: "json", complete: true });
    expect(JSON.parse(d.text)).toMatchObject({ server: "github", arguments: { title: "x > y", body: "`z`" } });
    const claude = decidingInput({ tool: "mcp__db__run", input: { sql: "DELETE FROM t" } });
    expect(JSON.parse(claude.text)).toEqual({ sql: "DELETE FROM t" });
  });
});

describe("Assistant cards and questions", () => {
  it("keeps an endpoint card's headline, every fact, its warning and its whole body", () => {
    const body = "m".repeat(20_000);
    const d = decidingInput({
      tool: "chat_send_message", input: {},
      summary: {
        headline: "Send a message", facts: [{ label: "Runs in", value: "Bypass", tone: "warning" }],
        body: { label: "Message", text: body, format: "text" }, warning: "runs unasked",
      },
    });
    expect(d).toMatchObject({ kind: "endpoint", title: "Send a message", text: body, complete: true });
    expect(d.facts).toEqual([{ label: "Runs in", value: "Bypass" }, { label: "Warning", value: "runs unasked" }]);
    expect(decidingInput({ tool: "db_query", input: {}, summary: { headline: "h", facts: [], body: { label: "SQL", text: "x", format: "sql" } } }).lang).toBe("sql");
  });

  it("lists a question's options, from the normalized questions or Claude's input", () => {
    const d = decidingInput({ tool: "AskUserQuestion", input: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "first" }, { label: "B" }], multiSelect: true }] } });
    expect(d.kind).toBe("question");
    expect(d.text).toBe("[Pick] Which?\n  - A — first\n  - B\n  - (or a typed answer)\n  (several may be chosen)");
    const codex = decidingInput({ tool: "AskUserQuestion", input: "ignored", questions: [{ id: "x", question: "Name?", options: [], multiSelect: false, allowsFreeText: true }] });
    expect(codex.text).toBe("Name?\n  (a typed answer)");
  });
});
