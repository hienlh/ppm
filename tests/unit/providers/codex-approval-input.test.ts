/**
 * A codex approval card shows what the user decides on: the script, where it runs and why,
 * titled with the shell that runs it. The live trial's card showed the whole request as a
 * double-escaped JSON string titled "Bash" for a PowerShell `dir`.
 */
import { describe, expect, it } from "bun:test";
import { approvalInput, approvalToolLabel } from "../../../src/providers/codex-app-server/codex-approval-input.ts";
import { redactFields } from "../../../src/providers/codex-app-server/codex-redact.ts";

// The request codex sent in the live trial, as the provider receives it.
const WINDOWS_COMMAND = {
  kind: "command",
  threadId: "01a1264f-74e7-7d32-9495-428fabbe2a86",
  turnId: "01a12650-4894-7112-a814-2778a7030a3d",
  itemId: "exec-42dbd8c4-1516-4e0c-a516-6be3baa0e26c",
  startedAtMs: 1791644163947,
  environmentId: "local",
  command: "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command dir",
  cwd: "C:\\Users\\PC\\AppData\\Local\\Temp\\ppm-live-codex-9vimWn\\alpha",
  commandActions: [{ type: "unknown", command: "dir" }],
  proposedExecpolicyAmendment: ["dir"],
  availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["dir"] } }, "cancel"],
};

describe("command approval", () => {
  it("shows the script and its directory as an object, not a JSON string", () => {
    const input = approvalInput("item/commandExecution/requestApproval", WINDOWS_COMMAND);
    expect(input).toEqual({ command: "dir", cwd: "C:\\Users\\PC\\AppData\\Local\\Temp\\ppm-live-codex-9vimWn\\alpha" });
  });

  it("names the shell that runs it", () => {
    expect(approvalToolLabel("item/commandExecution/requestApproval", WINDOWS_COMMAND)).toBe("PowerShell");
    expect(approvalToolLabel("item/commandExecution/requestApproval", { command: "/bin/bash -lc 'ls -la'" })).toBe("Bash");
    expect(approvalToolLabel("execCommandApproval", { command: ["pwsh", "-Command", "ls"] })).toBe("PowerShell");
  });

  it("keeps codex's reason, and falls back to the wrapped command when there are no actions", () => {
    expect(approvalInput("item/commandExecution/requestApproval", { command: "bash -lc 'make'", cwd: "/p", reason: "Build it" }))
      .toEqual({ command: "bash -lc 'make'", cwd: "/p", reason: "Build it" });
  });

  it("reads the legacy request: argv beside parsedCmd", () => {
    expect(approvalInput("execCommandApproval", {
      conversationId: "c", callId: "x", command: ["bash", "-lc", "rm -rf build"], cwd: "/p",
      parsedCmd: [{ type: "unknown", cmd: "rm -rf build" }],
    })).toEqual({ command: "rm -rf build", cwd: "/p" });
  });

  it("redacts each field on its own", () => {
    const input = approvalInput("item/commandExecution/requestApproval", {
      command: "curl -H x", commandActions: [{ command: "curl -H 'Authorization: Bearer sk-abcdef0123456789abcd'" }], cwd: "/p",
    }) as { command: string };
    expect(input.command).toContain("sk-***");
    expect(input.command).not.toContain("sk-abcdef0123456789abcd");
  });
});

describe("file change approval", () => {
  it("shows the reason and, from the legacy request, the files", () => {
    expect(approvalToolLabel("item/fileChange/requestApproval", {})).toBe("Edit");
    expect(approvalInput("item/fileChange/requestApproval", { threadId: "t", turnId: "u", itemId: "i", reason: "Needs write access" }))
      .toEqual({ reason: "Needs write access" });
    expect(approvalInput("applyPatchApproval", { fileChanges: { "/p/a.ts": {}, "/p/b.ts": {} }, grantRoot: "/p" }))
      .toEqual({ files: ["/p/a.ts", "/p/b.ts"], grantRoot: "/p" });
  });
});

describe("redactFields", () => {
  it("keeps the shape and redacts strings inside it", () => {
    expect(redactFields({ a: "key sk-abcdef0123456789abcd", n: 1, list: ["x", { b: true }] }))
      .toEqual({ a: "key sk-***", n: 1, list: ["x", { b: true }] });
  });

  it("still redacts a value that is a secret only by its field's name", () => {
    expect(redactFields({ token: "abcdefghijklmnop1234" })).toEqual({ token: "***" });
  });

  it("caps each string and flattens an oversized value back into one capped string", () => {
    expect((redactFields({ s: "x".repeat(50) }, 10) as { s: string }).s).toContain("truncated 40 chars");
    const huge = Array.from({ length: 100 }, (_, i) => ({ [`k${i}`]: "y".repeat(5000) }));
    expect(typeof redactFields(huge)).toBe("string");
  });
});
