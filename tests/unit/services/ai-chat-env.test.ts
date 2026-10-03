/**
 * The mark that tells `ppm db` it runs in an AI chat: set on the processes the chat providers
 * start, and taken out of PPM's own terminal, where a person types. Both are checked on real
 * child processes, since the mark only matters once a child inherits it; the Claude and Codex
 * providers are covered in their own tests, which already capture their spawn environments.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_CHAT_ENV, inAiChat, withoutAiChatMark } from "../../../src/services/ai-chat-env.ts";
import { CliProvider } from "../../../src/providers/cli-provider-base.ts";
import { TerminalService } from "../../../src/services/terminal.service.ts";

const saved = { mark: process.env[AI_CHAT_ENV], shell: process.env.SHELL };
afterEach(() => {
  for (const [key, value] of [[AI_CHAT_ENV, saved.mark], ["SHELL", saved.shell]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("inAiChat", () => {
  it("is on for any value but an empty one or 0", () => {
    expect([undefined, "", "0", "1", "yes"].map((v) => inAiChat({ [AI_CHAT_ENV]: v }))).toEqual([false, false, false, true, true]);
  });
});

describe("withoutAiChatMark", () => {
  it("drops the mark and nothing else, leaving the environment it was given alone", () => {
    const env = { PATH: "/bin", [AI_CHAT_ENV]: "1" };
    expect(withoutAiChatMark(env)).toEqual({ PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin", [AI_CHAT_ENV]: "1" });
  });
});

/** A CLI provider whose "CLI" is bun, printing the mark it was started with. */
class EnvEchoProvider extends CliProvider {
  readonly id = "env-echo";
  readonly name = "Env echo";
  readonly cliCommand = process.execPath;
  buildArgs() { return []; }
  mapEvent() { return []; }
  extractSessionId() { return null; }
  async isAvailable() { return true; }
  markSeenByChild(): Promise<string> {
    const child = this.spawnProcess(["-e", `process.stdout.write(process.env.${AI_CHAT_ENV} ?? "none")`], process.cwd());
    return new Promise((resolve, reject) => {
      let out = "";
      child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
      child.on("error", reject);
      child.on("close", () => resolve(out));
    });
  }
}

describe("chat providers that spawn a CLI (Cursor)", () => {
  it("start it with the mark", async () => {
    delete process.env[AI_CHAT_ENV];
    expect(await new EnvEchoProvider().markSeenByChild()).toBe("1");
  });
});

describe("PPM's own terminal", () => {
  // Windows runs cmd.exe through bun-pty; the shell syntax below is POSIX sh.
  it.skipIf(process.platform === "win32")("does not pass on the mark of a chat PPM itself was started from", async () => {
    process.env[AI_CHAT_ENV] = "1";
    process.env.SHELL = "/bin/sh";
    const dir = mkdtempSync(join(tmpdir(), "ppm-terminal-mark-"));
    const terminals = new TerminalService();
    const id = terminals.create(dir);
    try {
      // The typed line is echoed back too, and it holds neither answer below.
      terminals.write(id, `echo "mark=[\${${AI_CHAT_ENV}:-none}]"\n`);
      const deadline = Date.now() + 15_000;
      let out = "";
      while (Date.now() < deadline && !/mark=\[(none|1)\]/.test(out)) {
        await Bun.sleep(50);
        out = terminals.getBuffer(id);
      }
      expect(out).toContain("mark=[none]");
    } finally {
      terminals.kill(id);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
