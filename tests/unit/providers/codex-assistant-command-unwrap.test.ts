/**
 * The script inside a Codex command approval's shell wrapper. Only the wrappers Codex itself
 * uses are taken apart; every other shape is null, which keeps the command's card.
 */
import { describe, expect, it } from "bun:test";
import { decodePosixWord, unwrapCodexCommand } from "../../../src/providers/codex-app-server/codex-assistant-command-unwrap.ts";

// As recorded from codex on Windows (codex-approval-input.test.ts): the path quoted, every backslash doubled.
const WIN_PS = "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command dir";

describe("the current protocol's display string", () => {
  it("unwraps Windows PowerShell as Codex sends it", () => {
    expect(unwrapCodexCommand(WIN_PS)).toEqual({ shell: "powershell", script: "dir" });
    expect(unwrapCodexCommand("\"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe\" -NoProfile -Command Get-ChildItem C:\\\\x"))
      .toEqual({ shell: "powershell", script: "Get-ChildItem C:\\\\x" });
    expect(unwrapCodexCommand("pwsh -NoLogo -NonInteractive -Command \"Get-Date\"")).toEqual({ shell: "powershell", script: "Get-Date" });
  });

  it("unwraps bash with one single-quoted word", () => {
    expect(unwrapCodexCommand("/bin/bash -lc 'ls -la'")).toEqual({ shell: "bash", script: "ls -la" });
    expect(unwrapCodexCommand("bash -c 'echo it'\\''s'")).toEqual({ shell: "bash", script: "echo it's" });
    expect(unwrapCodexCommand("/usr/bin/bash -lc ls")).toEqual({ shell: "bash", script: "ls" });
  });

  it("refuses anything else", () => {
    for (const text of [
      "/bin/bash -lc 'ls' 'rm -rf /'",           // a second word
      "/bin/bash -lc 'ls'; rm -rf /",            // text after the word
      "/bin/bash -lc \"ls $HOME\"",              // double quotes
      "/bin/bash -lc ls -la",                    // two bare words
      "/bin/zsh -lc 'ls'",                       // another shell
      "/tmp/bash -lc 'ls'",                      // a bash that is not the system's
      "sh -c 'ls'",
      "cmd.exe /c dir",
      "powershell.exe -ExecutionPolicy Bypass -Command dir", // a switch that changes what may run
      "powershell.exe -EncodedCommand ZABpAHIA",
      "powershell.exe -Command \"dir\" ; calc",  // quotes that do not wrap the whole script
      "powershell.exe -Command \"dir \\\"x\\\"\"",
      "\"C:\\\\evil\\\\notpowershell.exe\" -Command dir",
      " /bin/bash -lc 'ls'",
      "",
    ]) expect(unwrapCodexCommand(text)).toBeNull();
  });
});

describe("the legacy protocol's argv", () => {
  it("unwraps exactly the shapes Codex sends", () => {
    expect(unwrapCodexCommand(["bash", "-lc", "rm -rf build"])).toEqual({ shell: "bash", script: "rm -rf build" });
    expect(unwrapCodexCommand(["/bin/bash", "-c", "ls"])).toEqual({ shell: "bash", script: "ls" });
    expect(unwrapCodexCommand(["pwsh", "-Command", "ls"])).toEqual({ shell: "powershell", script: "ls" });
    expect(unwrapCodexCommand(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoProfile", "-Command", "dir"]))
      .toEqual({ shell: "powershell", script: "dir" });
  });

  it("refuses any other argv", () => {
    for (const argv of [
      ["bash", "-lc", "ls", "extra"], ["bash", "ls"], ["bash", "-x", "-c", "ls"], ["sh", "-c", "ls"], ["ls", "-la"],
      ["pwsh", "-File", "x.ps1"], ["pwsh", "-ExecutionPolicy", "Bypass", "-Command", "ls"], ["pwsh", "-Command"],
      ["bash", "-lc", 1], [],
    ]) expect(unwrapCodexCommand(argv)).toBeNull();
    expect(unwrapCodexCommand(null)).toBeNull();
    expect(unwrapCodexCommand({ command: "ls" })).toBeNull();
  });
});

describe("decodePosixWord", () => {
  it("reads single-quoted pieces and safe bare words only", () => {
    expect(decodePosixWord("'a b'")).toBe("a b");
    expect(decodePosixWord("''")).toBe("");
    expect(decodePosixWord("'a'\\''b'\\''c'")).toBe("a'b'c");
    expect(decodePosixWord("src/a.ts")).toBe("src/a.ts");
    for (const w of ["'a' 'b'", "'a", "a b", "$x", "\"a\"", "'a'b", "a;b", "`x`"]) expect(decodePosixWord(w)).toBeNull();
  });
});
