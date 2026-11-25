/**
 * "Allow for this chat" rules saved from a Claude approval card. A rule must never cover more
 * than the card showed: a command that chains, pipes, redirects or substitutes is covered only by
 * its exact text.
 */
import { describe, expect, it } from "bun:test";
import * as rules from "../../../src/services/chat-approval-rules.ts";

const bash = (command: string) => ({ command });

describe("approvalRuleFor", () => {
  it("names a shell command by its program and subcommand", () => {
    expect(rules.approvalRuleFor("Bash", bash("git status --short"))).toEqual({ key: "bash:git status", label: "`git status` commands" });
    expect(rules.approvalRuleFor("Bash", bash("ls -la src"))).toEqual({ key: "bash:ls", label: "`ls` commands" });
    expect(rules.approvalRuleFor("Bash", bash("./scripts/test.sh x"))).toEqual({ key: "bash:./scripts/test.sh", label: "`./scripts/test.sh` commands" });
  });

  it("offers only the exact text for a composed command", () => {
    for (const c of ["git status; rm -rf x", "cat a | sh", "echo $(id)", "ls > out", "a && b", "echo `id`"]) {
      expect(rules.approvalRuleFor("Bash", bash(c))?.key).toBe(`bash-exact:${c}`);
    }
  });

  it("groups file edits, names other tools, and offers nothing for questions and plan mode", () => {
    expect(rules.approvalRuleFor("Write", { file_path: "a" })?.key).toBe("edits");
    expect(rules.approvalRuleFor("mcp__github__create_issue", {})?.key).toBe("tool:mcp__github__create_issue");
    expect(rules.approvalRuleFor("AskUserQuestion", {})).toBeNull();
    expect(rules.approvalRuleFor("ExitPlanMode", {})).toBeNull();
  });
});

describe("ruleCovers", () => {
  it("a prefix rule covers the same program and subcommand, and nothing composed", () => {
    expect(rules.ruleCovers("bash:git status", "Bash", bash("git status"))).toBe(true);
    expect(rules.ruleCovers("bash:git status", "Bash", bash("git status --porcelain"))).toBe(true);
    expect(rules.ruleCovers("bash:git status", "Bash", bash("git push"))).toBe(false);
    expect(rules.ruleCovers("bash:git status", "Bash", bash("git status && git push"))).toBe(false);
    expect(rules.ruleCovers("bash:git status", "Bash", bash("git statusx"))).toBe(false);
    expect(rules.ruleCovers("bash:ls", "Bash", bash("ls\nrm -rf x"))).toBe(false);
    expect(rules.ruleCovers("bash:ls", "Edit", bash("ls"))).toBe(false);
  });

  it("an exact rule covers only that text; edits cover every edit tool; a tool rule only its tool", () => {
    expect(rules.ruleCovers("bash-exact:a && b", "Bash", bash("a && b"))).toBe(true);
    expect(rules.ruleCovers("bash-exact:a && b", "Bash", bash("a && b && c"))).toBe(false);
    expect(rules.ruleCovers("edits", "MultiEdit", {})).toBe(true);
    expect(rules.ruleCovers("edits", "Bash", bash("ls"))).toBe(false);
    expect(rules.ruleCovers("tool:WebFetch", "WebFetch", {})).toBe(true);
    expect(rules.ruleCovers("tool:WebFetch", "WebSearch", {})).toBe(false);
  });
});

describe("saved rules", () => {
  it("a chat rule answers for that chat only", () => {
    rules.allowForChat("chat-a", "bash:bun test");
    expect(rules.chatAllows("chat-a", "Bash", bash("bun test x"))).toBe(true);
    expect(rules.chatAllows("chat-a", "Bash", bash("bun install"))).toBe(false);
    expect(rules.chatAllows("chat-b", "Bash", bash("bun test x"))).toBe(false);
  });

  it("reads the card's answer defensively", () => {
    expect(rules.approvalChoiceFrom({ scope: "chat" })).toEqual({ scope: "chat" });
    expect(rules.approvalChoiceFrom({ scope: "everywhere", message: "  " })).toEqual({});
    // A project-wide rule is "Allow & remember", never this card's answer.
    expect(rules.approvalChoiceFrom({ scope: "project" })).toEqual({});
    expect(rules.approvalChoiceFrom({ message: " use bun " })).toEqual({ message: "use bun" });
    expect(rules.approvalChoiceFrom("yes")).toEqual({});
  });
});
