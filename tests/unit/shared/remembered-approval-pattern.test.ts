/**
 * What a remembered approval may cover. Every refusal is checked on every request, so a rule made
 * for a harmless command never stretches to a dangerous one. Every entry of the deny list is
 * walked here, so shortening it fails a test.
 */
import { describe, expect, it } from "bun:test";
import {
  approvalPatternFor, commandWords, matchesRule, projectRelative, type ApprovalRequestShape,
} from "../../../src/shared/remembered-approval-pattern.ts";
import {
  DENIED_COMMANDS, DENIED_FLAGS, DENIED_GIT_SUBCOMMANDS, DENIED_PACKAGE_SUBCOMMANDS, DENIED_TOOLS,
} from "../../../src/shared/remembered-approval-denylist.ts";

const project = "D:/Projects/app";
const bash = (command: string): ApprovalRequestShape => ({ tool: "Bash", input: { command }, projectPath: project });
const edit = (file_path: string): ApprovalRequestShape => ({ tool: "Edit", input: { file_path }, projectPath: project });
const collab = (input: unknown): ApprovalRequestShape => ({ tool: "ppm:session_collab", input, projectPath: project });

describe("shell commands", () => {
  it("are remembered by their first word and a subcommand", () => {
    expect(approvalPatternFor(bash("git status"))).toEqual({ kind: "command", pattern: "git status", label: "Run `git status`" });
    expect(approvalPatternFor(bash("bun test tests/unit/x.test.ts"))?.pattern).toBe("bun test");
    expect(approvalPatternFor(bash("bun run build --watch"))?.pattern).toBe("bun run build");
    expect(approvalPatternFor(bash("python scripts/report.py --day 3"))?.pattern).toBe("python scripts/report.py");
    expect(approvalPatternFor(bash("ls -la"))?.pattern).toBe("ls");
    expect(approvalPatternFor(bash("C:\\Tools\\rg.exe foo"))?.pattern).toBe("rg");
    expect(approvalPatternFor(bash("./scripts/deploy.sh prod"))).toBeNull();
  });

  it("are never remembered when joined, piped, redirected or substituted", () => {
    for (const c of ["git status; rm -rf x", "git status && echo", "ls | sh", "echo x > a.txt", "cat < a", "echo `id`", "echo $(id)", "echo ${HOME}", "a &", "ls\nrm x"]) {
      expect(commandWords(c)).toBeNull();
      expect(approvalPatternFor(bash(c))).toBeNull();
    }
  });

  it("refuses every denied command, as a first word in any spelling", () => {
    for (const c of DENIED_COMMANDS) {
      if (c === ".") continue;
      expect(approvalPatternFor(bash(`${c} something`))).toBeNull();
      expect(approvalPatternFor(bash(`/usr/bin/${c.toUpperCase()}.exe something`))).toBeNull();
    }
  });

  it("refuses every denied flag, git subcommand and package-manager subcommand", () => {
    for (const f of DENIED_FLAGS) expect(approvalPatternFor(bash(`ls ${f}`))).toBeNull();
    for (const s of DENIED_GIT_SUBCOMMANDS) expect(approvalPatternFor(bash(`git ${s} x`))).toBeNull();
    for (const s of DENIED_PACKAGE_SUBCOMMANDS) {
      for (const pm of ["npm", "bun", "pnpm", "pip", "cargo"]) expect(approvalPatternFor(bash(`${pm} ${s} x`))).toBeNull();
    }
    expect(approvalPatternFor(bash("git log -f"))).toBeNull();
  });

  it("refuses inline code and in-place rewrites, but not the same flags where they are harmless", () => {
    expect(approvalPatternFor(bash("python -c 'import os'"))).toBeNull();
    expect(approvalPatternFor(bash("node -e 1"))).toBeNull();
    expect(approvalPatternFor(bash("sed -i s/a/b/ f"))).toBeNull();
    expect(approvalPatternFor(bash("grep -i foo src"))?.pattern).toBe("grep");
    expect(approvalPatternFor(bash("tail -f app.log"))?.pattern).toBe("tail");
  });

  it("matches a rule only word for word, and never past a refusal", () => {
    const rule = { kind: "command", pattern: "git status" };
    expect(matchesRule(rule, bash("git status --short"))).toBe(true);
    expect(matchesRule(rule, bash("git statusx"))).toBe(false);
    expect(matchesRule(rule, bash("git status; rm -rf /"))).toBe(false);
    expect(matchesRule(rule, bash("git log"))).toBe(false);
    expect(matchesRule({ kind: "command", pattern: "ls" }, bash("ls --delete"))).toBe(false);
    expect(matchesRule(rule, { ...bash("git status"), tool: "PowerShell" })).toBe(true);
  });
});

describe("file edits", () => {
  it("are remembered by the project folder they are in", () => {
    expect(approvalPatternFor(edit("D:/Projects/app/src/web/a.tsx"))).toEqual({ kind: "file_edit", pattern: "src/web/", label: "Edit files in src/web/" });
    expect(approvalPatternFor(edit("d:\\projects\\APP\\src\\b.ts"))?.pattern).toBe("src/");
    expect(approvalPatternFor({ tool: "Edit", input: { files: ["D:/Projects/app/src/a/x.ts", "D:/Projects/app/src/b/y.ts"] }, projectPath: project })?.pattern).toBe("src/");
  });

  it("are never remembered outside the project or on a secret", () => {
    for (const f of ["D:/Projects/other/a.ts", "D:/Projects/app/../other/a.ts", "C:/Windows/x", "D:/Projects/app/.env", "D:/Projects/app/.env.local",
      "D:/Projects/app/.git/config", "D:/Projects/app/keys/server.pem", "D:/Projects/app/node_modules/x/i.js", "D:/Projects/app/.ppm/manager.md"]) {
      expect(approvalPatternFor(edit(f))).toBeNull();
    }
  });

  it("match a rule for the folder and those inside it, not beside it", () => {
    const rule = { kind: "file_edit", pattern: "src/web/" };
    expect(matchesRule(rule, edit("D:/Projects/app/src/web/x/y.tsx"))).toBe(true);
    expect(matchesRule(rule, edit("D:/Projects/app/src/webx/y.tsx"))).toBe(false);
    expect(matchesRule(rule, edit("D:/Projects/app/src/server/y.ts"))).toBe(false);
    expect(matchesRule({ kind: "file_edit", pattern: "" }, edit("D:/Projects/app/src/a.ts"))).toBe(false);
  });

  it("works out folders inside the project and refuses those above it", () => {
    expect(projectRelative("src/a.ts", project)).toBe("src/a.ts");
    expect(projectRelative("/p/app/src/a.ts", "/p/app")).toBe("src/a.ts");
    expect(projectRelative("/p/App/src/a.ts", "/p/app")).toBeNull();
    expect(projectRelative("../x", project)).toBeNull();
  });
});

describe("session tools", () => {
  it("remember opening a chat and the pair limit, never an escalation, a message, a schedule or the Assistant's own", () => {
    expect(approvalPatternFor(collab({ kind: "create" }))?.kind).toBe("collab:create");
    expect(approvalPatternFor(collab({ kind: "pair_limit" }))?.kind).toBe("collab:pair_limit");
    for (const kind of ["escalation", "message", "schedule"]) expect(approvalPatternFor(collab({ kind }))).toBeNull();
    expect(approvalPatternFor(collab({ kind: "create", askedBy: "assistant" }))).toBeNull();
  });
});

describe("other tools", () => {
  it("remember reading tools by name and refuse the rest by default", () => {
    expect(approvalPatternFor({ tool: "Read", input: {}, projectPath: project })?.kind).toBe("tool");
    for (const t of DENIED_TOOLS) expect(approvalPatternFor({ tool: t, input: {}, projectPath: project })).toBeNull();
    expect(approvalPatternFor({ tool: "SomethingNew", input: {}, projectPath: project })).toBeNull();
    expect(approvalPatternFor({ tool: "db_execute", input: {}, projectPath: project })).toBeNull();
    expect(approvalPatternFor({ tool: "ppm:db_execute", input: {}, projectPath: project })).toBeNull();
  });

  it("remember an MCP tool by its full name unless its name acts on the world", () => {
    expect(approvalPatternFor({ tool: "mcp__jira__get_issue", input: {}, projectPath: project })?.pattern).toBe("mcp__jira__get_issue");
    for (const t of ["mcp__slack__send_message", "mcp__gh__create_pr", "mcp__db__delete_row", "mcp__x__deploy", "mcp__playwright__browser_click", "linear.update_issue"]) {
      expect(approvalPatternFor({ tool: t, input: {}, projectPath: project })).toBeNull();
    }
  });
});
