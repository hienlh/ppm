import { describe, it, expect } from "bun:test";
import { commandDisplayText } from "../../../src/providers/codex-app-server/codex-event-mapper.ts";
import { mapCodexEvent } from "../../../src/providers/codex-app-server/codex-event-mapper.ts";

const SID = "thread-1";

/**
 * A commandExecution item as codex actually emits it on Windows: `command` is
 * the interpreter-wrapped form whose path has every backslash doubled, and
 * `commandActions[].command` is the unwrapped script.
 */
const WINDOWS_ITEM = {
  type: "commandExecution",
  id: "i1",
  command:
    '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" ' +
    "-Command 'Get-Content -LiteralPath README.md -TotalCount 160'",
  cwd: "C:\\Users\\PC\\ppm",
  commandActions: [{ type: "unknown", command: "Get-Content -LiteralPath README.md -TotalCount 160" }],
};

describe("commandDisplayText", () => {
  it("prefers the unwrapped action over the doubled-backslash wrapper", () => {
    expect(commandDisplayText(WINDOWS_ITEM)).toBe("Get-Content -LiteralPath README.md -TotalCount 160");
  });

  it("never surfaces a doubled backslash that only exists in the wrapper", () => {
    expect(commandDisplayText(WINDOWS_ITEM)).not.toContain("\\\\");
  });

  it("keeps a real doubled backslash that the script itself contains", () => {
    // A bash script may legitimately hold `\\` (escaped path, regex). Preferring
    // commandActions must not be confused with un-escaping the text.
    const item = { command: "wrapper", commandActions: [{ command: "grep 'a\\\\b' file" }] };
    expect(commandDisplayText(item)).toBe("grep 'a\\\\b' file");
  });

  it("joins several actions by newline", () => {
    const item = { command: "w", commandActions: [{ command: "cd /x" }, { command: "ls" }] };
    expect(commandDisplayText(item)).toBe("cd /x\nls");
  });

  it("falls back to the wrapped command when there are no actions", () => {
    expect(commandDisplayText({ command: "ls -la" })).toBe("ls -la");
    expect(commandDisplayText({ command: "ls -la", commandActions: [] })).toBe("ls -la");
  });

  it("falls back when every action command is blank or non-string", () => {
    const item = { command: "ls -la", commandActions: [{ command: "   " }, { command: 42 }, {}] };
    expect(commandDisplayText(item)).toBe("ls -la");
  });

  it("is empty, not undefined, for an item with neither field", () => {
    expect(commandDisplayText({})).toBe("");
  });
});

describe("commandExecution → tool_use", () => {
  it("shows the unwrapped script but still detects PowerShell from the wrapper", () => {
    const out = mapCodexEvent({ method: "item/started", params: { item: WINDOWS_ITEM } }, SID);
    expect(out).toEqual([{
      type: "tool_use",
      tool: "PowerShell",
      input: { command: "Get-Content -LiteralPath README.md -TotalCount 160", cwd: "C:\\Users\\PC\\ppm" },
      toolUseId: "i1",
    }]);
  });

  it("still resolves to Bash when the wrapper names no shell", () => {
    const out = mapCodexEvent({
      method: "item/started",
      params: { item: { type: "commandExecution", id: "i2", command: "/bin/sh -c 'ls'", commandActions: [{ command: "ls" }] } },
    }, SID);
    expect((out[0] as { tool: string }).tool).toBe("Bash");
  });
});
