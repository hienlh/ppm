import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  buildToolHooks,
  FILE_WRITE_TOOLS_MATCHER,
  fileWriteTarget,
  preToolUseDecision,
  SHELL_TOOLS_MATCHER,
  shellHookCall,
} from "../../../src/providers/claude-agent-sdk-query-options.ts";

const preToolUse = async () => ({});
const fileWrite = async () => ({});
const shellCommand = async () => ({});

describe("buildToolHooks", () => {
  test("bypass mode gets the file-write and shell hooks, before and after the tool, and no permission hook", () => {
    const shell = { matcher: SHELL_TOOLS_MATCHER, hooks: [shellCommand] };
    const write = { matcher: FILE_WRITE_TOOLS_MATCHER, hooks: [fileWrite] };
    expect(buildToolHooks({ isBypass: true, preToolUse, fileWrite, shellCommand })).toEqual({
      PreToolUse: [write, shell],
      PostToolUse: [shell, write],
      PostToolUseFailure: [shell, write],
    });
  });

  test("other modes run the shell and file-write hooks from the permission hook, once the call is allowed", async () => {
    const log: string[] = [];
    let verdict: unknown = preToolUseDecision("allow");
    const hooks = buildToolHooks({
      isBypass: false,
      preToolUse: async (input: { tool_name: string }) => { log.push(`permission:${input.tool_name}`); return verdict; },
      fileWrite: async (input: { tool_name: string }) => { log.push(`write:${input.tool_name}`); return {}; },
      shellCommand: async (input: { tool_name: string }) => { log.push(`shell:${input.tool_name}`); return {}; },
    });
    expect(hooks.PreToolUse.map((m) => m.matcher)).toEqual([".*"]);
    expect(hooks.PostToolUse.map((m) => m.matcher)).toEqual([SHELL_TOOLS_MATCHER, FILE_WRITE_TOOLS_MATCHER]);
    const gate = hooks.PreToolUse[0]!.hooks[0]!;
    const bash = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "ls" } };
    const edit = { hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "toolu_2", tool_input: { file_path: "/p/a.ts" } };

    expect(await gate(bash)).toBe(verdict);
    expect(await gate(edit)).toBe(verdict);
    expect(log).toEqual(["permission:Bash", "shell:Bash", "permission:Edit", "write:Edit"]);

    log.length = 0;
    await gate({ ...bash, tool_name: "Read" });
    expect(log).toEqual(["permission:Read"]);

    log.length = 0;
    verdict = preToolUseDecision("deny", "User denied tool execution");
    expect(await gate(bash)).toBe(verdict);
    expect(await gate(edit)).toBe(verdict);
    expect(log).toEqual(["permission:Bash", "permission:Edit"]);
  });

  test("the matcher names every tool the change rollup counts as a file write", () => {
    expect(FILE_WRITE_TOOLS_MATCHER.split("|").sort()).toEqual(["Edit", "MultiEdit", "NotebookEdit", "Write"]);
  });
});

describe("shellHookCall", () => {
  const base = { tool_name: "Bash", tool_use_id: "toolu_9", tool_input: { command: "cp a b" }, cwd: "/p" };

  test("starts a command before it runs and ends it however it ended", () => {
    expect(shellHookCall({ ...base, hook_event_name: "PreToolUse" })).toEqual({ phase: "begin", toolUseId: "toolu_9", cwd: "/p", command: "cp a b" });
    expect(shellHookCall({ ...base, hook_event_name: "PostToolUse" })?.phase).toBe("end");
    expect(shellHookCall({ ...base, hook_event_name: "PostToolUseFailure", tool_name: "PowerShell" })?.phase).toBe("end");
  });

  test("is null for any other tool, event, or a call without an id", () => {
    expect(shellHookCall({ ...base, hook_event_name: "PreToolUse", tool_name: "Edit" })).toBeNull();
    expect(shellHookCall({ ...base, hook_event_name: "Stop" })).toBeNull();
    expect(shellHookCall({ ...base, hook_event_name: "PreToolUse", tool_use_id: undefined })).toBeNull();
    expect(shellHookCall(null)).toBeNull();
  });
});

describe("fileWriteTarget", () => {
  test("reads the path each file tool names", () => {
    expect(fileWriteTarget("Write", { file_path: "/p/a.ts", content: "" })).toBe("/p/a.ts");
    expect(fileWriteTarget("Edit", { file_path: "/p/b.ts" })).toBe("/p/b.ts");
    expect(fileWriteTarget("MultiEdit", { file_path: "/p/c.ts", edits: [] })).toBe("/p/c.ts");
    expect(fileWriteTarget("NotebookEdit", { notebook_path: "/p/n.ipynb" })).toBe("/p/n.ipynb");
  });

  test("is null for any other tool or a call without a path", () => {
    expect(fileWriteTarget("Bash", { command: "rm -rf x", file_path: "/p/a.ts" })).toBeNull();
    expect(fileWriteTarget("NotebookEdit", { file_path: "/p/n.ipynb" })).toBeNull();
    expect(fileWriteTarget("Edit", {})).toBeNull();
    expect(fileWriteTarget("Edit", null)).toBeNull();
  });

  test("resolves a relative path against the session's directory", () => {
    expect(fileWriteTarget("Edit", { file_path: "src/a.ts" }, "/proj")).toBe(resolve("/proj", "src/a.ts"));
  });
});
