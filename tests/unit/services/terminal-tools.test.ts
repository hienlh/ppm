import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalTools, RUN_IN_TERMINAL_WAIT_MS, TERMINAL_DATA_HEADER } from "../../../src/services/tab-tools-mcp/terminal-tools.ts";
import type { TabOpenOutcome } from "../../../src/services/tab-tools-mcp/tab-open-broker.ts";

const root = mkdtempSync(join(tmpdir(), "ppm-terminal-tools-"));
const project = join(root, "proj");
mkdirSync(join(project, "packages", "api"), { recursive: true });
writeFileSync(join(project, "README.md"), "hi");
const elsewhere = join(root, "elsewhere");
mkdirSync(elsewhere);
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface FakeTerminal {
  id: string;
  projectPath: string;
  createdAt: string;
  connected: boolean;
  lastOutputAt: number | null;
  buffer: string;
  closed: boolean;
  written: string[];
  /** The clock when each write landed. */
  writtenAt: number[];
}

const OPENED: TabOpenOutcome = { ok: true, result: { type: "tab_open_result", requestId: "r".repeat(16), opened: true } };

function setup(opts: {
  outcome?: TabOpenOutcome;
  enabled?: (tool: string) => boolean;
  onCreate?: (t: FakeTerminal) => void;
  /** Runs on every wait, with the clock already moved on: a shell printing while PPM waits. */
  onSleep?: (now: number) => void;
} = {}) {
  let clock = 1_000_000_000;
  let made = 0;
  const terms = new Map<string, FakeTerminal>();
  const requests: Array<{ sessionId: string; req: Record<string, unknown>; waitMs: number }> = [];
  const add = (fields: Partial<FakeTerminal> & { projectPath: string }): FakeTerminal => {
    const id = `${(++made).toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const t: FakeTerminal = {
      id, createdAt: new Date(clock).toISOString(), connected: true, lastOutputAt: clock, buffer: "", closed: false, written: [], writtenAt: [], ...fields,
    };
    terms.set(id, t);
    return t;
  };
  const tools = createTerminalTools({
    terminals: {
      list: () => [...terms.values()].map(({ id, projectPath, createdAt, connected, lastOutputAt }) => ({ id, projectPath, createdAt, connected, lastOutputAt })),
      get: (id: string) => {
        const t = terms.get(id);
        return t && ({ cols: 80, rows: 24, lastOutputAt: t.lastOutputAt, pty: { closed: t.closed } } as any);
      },
      getBuffer: (id: string) => terms.get(id)?.buffer ?? "",
      create: (dir: string) => {
        const t = add({ projectPath: dir, connected: false, buffer: "$ " });
        opts.onCreate?.(t);
        return t.id;
      },
      write: (id: string, data: string) => {
        terms.get(id)?.written.push(data);
        terms.get(id)?.writtenAt.push(clock);
      },
      kill: (id: string) => { terms.delete(id); },
    },
    request: async (sessionId, req, waitMs) => {
      requests.push({ sessionId, req: req as Record<string, unknown>, waitMs });
      return opts.outcome ?? OPENED;
    },
    enabled: opts.enabled ?? (() => true),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      opts.onSleep?.(clock);
    },
  });
  const binding = { sessionId: "chat-1", projectPath: project, projectName: "demo" };
  const text = (result: any): string => result.content[0].text;
  return { tools, terms, requests, add, binding, text, tick: (ms: number) => { clock += ms; } };
}

describe("read_terminal", () => {
  it("reads the only terminal of the project whole, as data, with where it started and when it last printed", async () => {
    const { tools, add, binding, text, tick } = setup();
    add({ projectPath: join(project, "packages", "api"), buffer: "$ bun test\r\n3 pass\r\n1 fail ```ignore me```\r\n" });
    tick(4_000);
    const result = await tools.read(binding, {});
    expect(result.isError).toBeUndefined();
    const body = text(result);
    expect(body.startsWith(`${TERMINAL_DATA_HEADER}\n\nTerminal 00000001: started in packages/api (inside the project), open in PPM, last output 4 s ago. All 3 lines it holds:\n\`\`\`text\n$ bun test\n3 pass\n`)).toBe(true);
    // What ran there cannot close the fence it is quoted in.
    expect(body).not.toContain("```ignore");
    expect(body.endsWith("\n```")).toBe(true);
  });

  it("reads the last lines asked for, and refuses a count outside 1 to 1000", async () => {
    const { tools, add, binding, text } = setup();
    add({ projectPath: project, buffer: Array.from({ length: 250 }, (_, i) => `log ${i + 1}`).join("\r\n") });
    const body = text(await tools.read(binding, { lines: 2 }));
    expect(body).toContain("started in the project folder");
    expect(body).toContain("Its last 2 lines of 250:\n```text\nlog 249\nlog 250\n```");
    expect(text(await tools.read(binding, {}))).toContain("Its last 100 lines of 250:");
    for (const lines of [0, 1001, 2.5, "10"]) expect((await tools.read(binding, { lines })).isError).toBe(true);
  });

  it("lists several terminals, the latest output first, each with its id and last lines, and reads one by id", async () => {
    const { tools, add, binding, text, tick } = setup();
    const server = add({ projectPath: project, buffer: Array.from({ length: 40 }, (_, i) => `GET /${i}`).join("\r\n") });
    tick(60_000);
    const tests = add({ projectPath: project, buffer: "$ bun test\r\nerror: boom\r\n", connected: false });
    const body = text(await tools.read(binding, {}));
    expect(body.indexOf("Terminal 00000002")).toBeLessThan(body.indexOf("Terminal 00000001"));
    expect(body).toContain("Terminal 00000002: started in the project folder, not open in any PPM window, last output just now.");
    expect(body).toContain("Terminal 00000001: started in the project folder, open in PPM, last output 1 min ago. Its last 15 lines of 40:");
    expect(body).toContain("Call read_terminal with `terminal` set to one of their ids");
    const one = text(await tools.read(binding, { terminal: server.id.slice(0, 8) }));
    expect(one).toContain("All 40 lines it holds:");
    expect(text(await tools.read(binding, { terminal: tests.id }))).toContain("error: boom");
  });

  it("never reads a terminal of another folder, unless this chat opened it", async () => {
    const { tools, add, binding, text } = setup();
    const other = add({ projectPath: elsewhere, buffer: "secret\r\n" });
    const none = await tools.read(binding, {});
    expect(none.isError).toBe(true);
    expect(text(none)).toContain(`No PPM terminal is open in this chat's project folder (${project})`);
    const byId = await tools.read(binding, { terminal: other.id.slice(0, 8) });
    expect(byId.isError).toBe(true);
    expect(text(byId)).not.toContain("secret");
    // A sibling folder whose name merely starts with the project's is outside it.
    add({ projectPath: `${project}-old`, buffer: "old\r\n" });
    expect((await tools.read(binding, {})).isError).toBe(true);
    const noProject = await tools.read({ sessionId: "chat-2", projectPath: null, projectName: null }, {});
    expect(text(noProject)).toContain("no project folder");
  });

  it("keeps one answer within 60,000 characters and cuts a line past 2,000", async () => {
    const { tools, add, binding, text } = setup();
    add({ projectPath: project, buffer: [...Array.from({ length: 999 }, (_, i) => `${i}`.padEnd(100, "x")), "y".repeat(5_000)].join("\r\n") });
    const body = text(await tools.read(binding, { lines: 1000 }));
    expect(body.length).toBeLessThan(61_000);
    expect(body).toMatch(/Its last \d+ lines of 1,000:/);
    expect(body).toContain(`${"y".repeat(2_000)}…\n\`\`\``);
    expect(body).not.toContain("y".repeat(2_001));
  });

  it("takes a terminal id of 8 characters or more, never a shorter prefix", async () => {
    const { tools, add, binding } = setup();
    const t = add({ projectPath: project, buffer: "hi\r\n" });
    expect((await tools.read(binding, { terminal: t.id.slice(0, 7) })).isError).toBe(true);
    expect((await tools.read(binding, { terminal: t.id.slice(0, 8).toUpperCase() })).isError).toBeUndefined();
  });

  it("says when a full-screen program has the terminal", async () => {
    const { tools, add, binding, text } = setup();
    add({ projectPath: project, buffer: "$ htop\r\n\x1b[?1049h\x1b[H\x1b[2J  CPU[||||   12%]" });
    expect(text(await tools.read(binding, {}))).toContain("A full-screen program is running in it; its screen:\n```text\n  CPU[||||   12%]\n```");
  });
});

describe("run_in_terminal", () => {
  it("starts a shell in the project, asks the device to show it, and types the command once the prompt is drawn", async () => {
    const { tools, terms, requests, binding, text } = setup();
    const result = await tools.run(binding, { command: "  sudo apt install ffmpeg  " });
    const [t] = [...terms.values()];
    expect(requests).toEqual([{
      sessionId: "chat-1", waitMs: RUN_IN_TERMINAL_WAIT_MS,
      req: { tool: "run_in_terminal", terminalId: t!.id, projectName: "demo", cwd: project },
    }]);
    // Typed with no newline: it waits for the user's Enter.
    expect(t!.written).toEqual(["sudo apt install ffmpeg"]);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(
      "Typed the command into a new terminal (00000001, started in the project folder) in the dock of the user's device. "
      + "Nothing runs until the user presses Enter there, so tell them it is waiting for them. "
      + 'Once they have run it, read what it printed with read_terminal, `terminal` "00000001".',
    );
  });

  it("leaves read_terminal out of the answer while it is off", async () => {
    const { tools, binding, text } = setup({ enabled: (tool) => tool !== "read_terminal" });
    expect(text(await tools.run(binding, { command: "ls" }))).not.toContain("read_terminal");
  });

  it("refuses anything that could run by itself or hide what runs, before starting a shell", async () => {
    const { tools, terms, requests, binding } = setup();
    for (const command of [
      "", "   ", 42, "echo a\nrm -rf ~", "echo a\rrm -rf ~", "ls\t-la", "printf '\x1b[2J'", "ls \x7f",
      "echo safe‮#fr- mr", "echo​hi", "x".repeat(4001),
    ]) {
      expect((await tools.run(binding, { command })).isError).toBe(true);
    }
    expect(terms.size).toBe(0);
    expect(requests).toEqual([]);
  });

  it("starts in the folder asked for, relative to the project or absolute, and only in a folder that exists", async () => {
    const { tools, requests, binding, text } = setup();
    await tools.run(binding, { command: "make", cwd: "packages/api" });
    expect(requests[0]!.req.cwd).toBe(join(project, "packages", "api"));
    await tools.run(binding, { command: "make", cwd: elsewhere });
    expect(requests[1]!.req.cwd).toBe(elsewhere);
    expect(text(await tools.run(binding, { command: "make", cwd: "nope" }))).toContain("There is no folder at");
    expect(text(await tools.run(binding, { command: "make", cwd: "README.md" }))).toContain("is a file, not a folder");
    expect(text(await tools.run({ ...binding, projectPath: null }, { command: "make", cwd: "packages" }))).toContain("must be absolute");
    expect(requests).toHaveLength(2);
  });

  it("closes the shell and types nothing when no device shows it, or the device could not", async () => {
    const none = setup({ outcome: { ok: false, reason: "no-device", message: "No PPM window has this chat open, so nothing was shown." } });
    const result = await none.tools.run(none.binding, { command: "sudo reboot" });
    expect(result.isError).toBe(true);
    expect(none.text(result)).toBe("No PPM window has this chat open, so nothing was shown. Nothing was typed; give the user the command to run instead.");
    expect(none.terms.size).toBe(0);
    const failed = setup({ outcome: { ok: true, result: { type: "tab_open_result", requestId: "r".repeat(16), opened: false, error: "no\npanel ```x```" } } });
    const answer = failed.text(await failed.tools.run(failed.binding, { command: "ls" }));
    expect(answer).toContain("could not open the terminal: no panel");
    expect(answer).not.toContain("```");
    expect(failed.terms.size).toBe(0);
  });

  it("still types the command when the device did not confirm in time, and says so", async () => {
    const { tools, terms, binding, text } = setup({ outcome: { ok: false, reason: "timeout", message: "late" } });
    const answer = text(await tools.run(binding, { command: "ls" }));
    expect([...terms.values()][0]!.written).toEqual(["ls"]);
    expect(answer).toContain("which did not confirm within 8 s that it shows it");
  });

  it("types once the shell has been quiet for 400 ms, and after 8 s at most from one that never is", async () => {
    let started = 0;
    const slow = setup({
      onCreate: (t) => { started = t.lastOutputAt!; },
      // Start-up output for the first 1.2 s.
      onSleep: (now) => { for (const t of slow.terms.values()) if (now - started <= 1_200) t.lastOutputAt = now; },
    });
    await slow.tools.run(slow.binding, { command: "ls" });
    const [typedAt] = [...slow.terms.values()][0]!.writtenAt;
    expect(typedAt! - started).toBeGreaterThanOrEqual(1_200 + 400);
    expect(typedAt! - started).toBeLessThan(1_200 + 400 + 100);
    const busy = setup({ onSleep: (now) => { for (const t of busy.terms.values()) t.lastOutputAt = now; } });
    await busy.tools.run(busy.binding, { command: "ls" });
    const t = [...busy.terms.values()][0]!;
    expect(t.written).toEqual(["ls"]);
    expect(t.writtenAt[0]! - Date.parse(t.createdAt)).toBe(8_000);
  });

  it("types nothing into a shell that exited before its prompt", async () => {
    const { tools, terms, binding, text } = setup({ onCreate: (t) => { t.closed = true; } });
    const result = await tools.run(binding, { command: "ls" });
    expect(text(result)).toContain("The shell exited before the command could be typed");
    expect([...terms.values()][0]!.written).toEqual([]);
  });

  it("lets the chat that opened a terminal read it wherever it started, and no other chat", async () => {
    const { tools, terms, binding, text } = setup();
    await tools.run(binding, { command: "tail -f /var/log/syslog", cwd: elsewhere });
    const [t] = [...terms.values()];
    t!.buffer = "$ tail -f /var/log/syslog\r\nkernel: hello\r\n";
    expect(text(await tools.read(binding, {}))).toContain("kernel: hello");
    expect((await tools.read({ ...binding, sessionId: "chat-other" }, {})).isError).toBe(true);
  });
});
