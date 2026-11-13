/**
 * A terminal an AI typed into keeps the AI-chat mark for its whole life, so a `ppm` command the
 * user runs there still meets the rules PPM applies to an AI chat; any other terminal is a
 * person's and drops the mark, even when PPM itself was started from a chat. Checked on a real
 * shell, since the mark only matters once a child inherits it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_CHAT_ENV } from "../../../src/services/ai-chat-env.ts";
import { TerminalService, terminalEnv } from "../../../src/services/terminal.service.ts";
import { createTerminalTools } from "../../../src/services/tab-tools-mcp/terminal-tools.ts";
import { terminalTypeTool } from "../../../src/services/assistant-mcp/assistant-terminal-type-tool.ts";

const saved = { mark: process.env[AI_CHAT_ENV], shell: process.env.SHELL };
afterEach(() => {
  for (const [key, value] of [[AI_CHAT_ENV, saved.mark], ["SHELL", saved.shell]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("terminalEnv", () => {
  it("holds the mark only when asked, whatever the environment it starts from", () => {
    for (const base of [{ PATH: "/bin" }, { PATH: "/bin", [AI_CHAT_ENV]: "1" }, { PATH: "/bin", [AI_CHAT_ENV]: "0" }]) {
      expect(terminalEnv(base, true)[AI_CHAT_ENV]).toBe("1");
      expect(terminalEnv(base, false)).not.toHaveProperty(AI_CHAT_ENV);
      expect(terminalEnv(base, true).PATH).toBe("/bin");
    }
  });
});

/** What `$PPM_AI_CHAT` reads inside a fresh shell made with `aiMark`. */
async function markSeenByShell(aiMark: boolean): Promise<{ seen: string; listed: boolean | undefined; held: boolean | undefined }> {
  process.env.SHELL = "/bin/sh";
  const dir = mkdtempSync(join(tmpdir(), "ppm-terminal-ai-mark-"));
  const terminals = new TerminalService();
  const id = terminals.create(dir, { aiMark });
  try {
    // The typed line is echoed back too, and it holds neither answer below.
    terminals.write(id, `echo "mark=[\${${AI_CHAT_ENV}:-none}]"\n`);
    const deadline = Date.now() + 15_000;
    let match: RegExpMatchArray | null = null;
    while (Date.now() < deadline && !(match = terminals.getBuffer(id).match(/mark=\[(none|1)\]/))) await Bun.sleep(50);
    return { seen: match?.[1] ?? "timeout", listed: terminals.list().find((t) => t.id === id)?.aiMark, held: terminals.get(id)?.aiMark };
  } finally {
    terminals.kill(id);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Windows runs cmd.exe through bun-pty; the shell syntax here is POSIX sh.
describe.skipIf(process.platform === "win32")("a real terminal", () => {
  it("keeps the mark in a shell made with aiMark, even when PPM itself has none", async () => {
    delete process.env[AI_CHAT_ENV];
    expect(await markSeenByShell(true)).toEqual({ seen: "1", listed: true, held: true });
  }, 30_000);

  it("drops the mark from any other shell, even when PPM was started from a chat", async () => {
    process.env[AI_CHAT_ENV] = "1";
    expect(await markSeenByShell(false)).toEqual({ seen: "none", listed: false, held: false });
  }, 30_000);

  it("hands the mark to the command terminal_type typed, once the user presses Enter", async () => {
    delete process.env[AI_CHAT_ENV];
    process.env.SHELL = "/bin/sh";
    const dir = mkdtempSync(join(tmpdir(), "ppm-terminal-type-mark-"));
    const terminals = new TerminalService();
    const tools = createTerminalTools({
      terminals,
      request: async () => ({ ok: true, result: { type: "tab_open_result", requestId: "r".repeat(16), opened: true, shownProject: "web" } }),
      enabled: () => true,
    });
    const result = await terminalTypeTool(
      { sessionId: "assistant-1", provenanceAtCall: { startedBy: "user_ppm", untrusted: false } },
      { project: "api", command: `echo "seen=[\${${AI_CHAT_ENV}:-none}]"` },
      { enabled: () => true, unattended: () => false, projects: () => [{ name: "api", path: dir }], run: tools.run },
    ) as { isError?: boolean };
    const [terminal] = terminals.list();
    try {
      expect(result.isError).toBeUndefined();
      expect(terminal?.aiMark).toBe(true);
      // Typed, not run: nothing has printed the answer yet.
      await Bun.sleep(300);
      expect(terminals.getBuffer(terminal!.id)).not.toMatch(/seen=\[(none|1)\]/);
      terminals.write(terminal!.id, "\r");
      const deadline = Date.now() + 15_000;
      let match: RegExpMatchArray | null = null;
      while (Date.now() < deadline && !(match = terminals.getBuffer(terminal!.id).match(/seen=\[(none|1)\]/))) await Bun.sleep(50);
      expect(match?.[1]).toBe("1");
    } finally {
      if (terminal) terminals.kill(terminal.id);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
