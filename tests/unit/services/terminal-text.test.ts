import { describe, expect, it } from "bun:test";
import { renderTerminal } from "../../../src/services/tab-tools-mcp/terminal-text.ts";

const ESC = "\x1b";

describe("renderTerminal", () => {
  it("keeps a progress bar's last state and drops colors", async () => {
    const raw = `${ESC}[32mbuild${ESC}[0m start\r\nprogress 10%\rprogress 55%\rprogress 100%\r\ndone\r\n`;
    expect(await renderTerminal(raw, 80, 24)).toEqual({ lines: ["build start", "progress 100%", "done"], fullScreen: false });
  });

  it("reads a line editor's redraws as the line typed, not the suggestion it drew and erased", async () => {
    // zsh-autosuggestions draws the rest of a history entry in grey, then the next key erases it.
    const raw = `$ echo h${ESC}[90mistory secret${ESC}[39m${ESC}[13D${ESC}[Ki\r\nhi\r\n`;
    expect((await renderTerminal(raw, 80, 24)).lines).toEqual(["$ echo hi", "hi"]);
  });

  it("joins a wrapped row back to its line, keeping the spaces it ended with", async () => {
    const long = `${"a".repeat(18)}  ${"b".repeat(10)}`;
    expect((await renderTerminal(`${long}\r\nnext\r\n`, 20, 5)).lines).toEqual([long, "next"]);
  });

  it("shows a full-screen program's screen alone, and the shell's output again once it exits", async () => {
    const before = `$ ls\r\nfile.txt\r\n$ top\r\n`;
    const top = `${ESC}[?1049h${ESC}[H${ESC}[2Jtop - 10:00 up 1 day${ESC}[2;1HPID USER`;
    expect(await renderTerminal(before + top, 80, 24)).toEqual({ lines: ["top - 10:00 up 1 day", "PID USER"], fullScreen: true });
    const after = await renderTerminal(`${before}${top}${ESC}[?1049l$ `, 80, 24);
    expect(after.fullScreen).toBe(false);
    expect(after.lines.slice(0, 3)).toEqual(["$ ls", "file.txt", "$ top"]);
  });

  it("keeps history past the screen's height, and answers an empty terminal with no lines", async () => {
    const raw = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\r\n");
    const { lines } = await renderTerminal(raw, 80, 24);
    expect(lines).toHaveLength(300);
    expect(lines[0]).toBe("line 1");
    expect(lines.at(-1)).toBe("line 300");
    expect(await renderTerminal("", 80, 24)).toEqual({ lines: [], fullScreen: false });
  });
});
