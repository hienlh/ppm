/**
 * The Assistant's system tools: registered for both providers in one order, judged as clean or
 * outside text as decided, and each answering from real files in a scratch PPM folder — with
 * every seeded secret absent from what the agent would see.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { upsertProject } from "../../../src/services/db.service.ts";
import { _resetLogStoreForTests } from "../../../src/services/logs/log-store.ts";
import { ASSISTANT_TOOLS } from "../../../src/shared/assistant-tool-names.ts";
import { SYSTEM_TOOLS } from "../../../src/shared/assistant-system-tool-names.ts";
import { ASSISTANT_TOOL_DEFINITIONS } from "../../../src/services/assistant-mcp/assistant-mcp-tools.ts";
import { familyToolHandler } from "../../../src/services/assistant-mcp/assistant-tool-family.ts";
import { ownToolBringsOutsideText } from "../../../src/services/assistant/assistant-outside-text.ts";
import { boundedJson, SYSTEM_TOOL_MAX_BYTES, timeWindow } from "../../../src/services/assistant-mcp/assistant-system-tool-definitions.ts";
import { ppmLogsSearch, unsafeRegexReason } from "../../../src/services/assistant-mcp/assistant-system-logs-tool.ts";
import { downSample, ppmMemoryReport, readDiagWindow } from "../../../src/services/assistant-mcp/assistant-system-memory-tool.ts";
import { installLocation, ppmStatus, type StatusDeps } from "../../../src/services/assistant-mcp/assistant-system-status-tool.ts";

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;
const json = (r: unknown) => JSON.parse(text(r));
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

const T0 = Date.parse("2026-11-16T02:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const logLine = (sec: number, lv: string, tag: string, msg: string) => `[${iso(T0 + sec * 1000)}] [${lv}] [${tag}] ${msg}\n`;

/** Secrets and identifiers seeded into the logs; none may reach an answer. */
const SECRETS = [
  "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE1234",
  "ghp_FAKEfakeFAKEfakeFAKEfakeFAKEfake1234",
  "Zm9vYmFyLWJlYXJlci1zZWNyZXQ",
  "hunter2-password-value",
  "victor.secret@example.com",
  "C:\\Users\\victor",
  "4b8e2c1a-1111-2222-3333-444455556666",
  "acme-secret-project",
];

beforeEach(() => {
  _resetLogStoreForTests();
  for (const f of ["ppm.log", "mem-diag.log", "mem-diag.log.1"]) rmSync(join(getPpmDir(), f), { force: true });
});
afterAll(() => _resetLogStoreForTests());

describe("registration", () => {
  it("serves every system tool, in the order tools/list gives them, with a family handler", () => {
    for (const name of SYSTEM_TOOLS) {
      expect(ASSISTANT_TOOLS).toContain(name);
      expect(familyToolHandler(name)?.family).toBe("system");
    }
    expect(ASSISTANT_TOOL_DEFINITIONS.map((d) => d.name)).toEqual([...ASSISTANT_TOOLS]);
    for (const d of ASSISTANT_TOOL_DEFINITIONS.filter((x) => (SYSTEM_TOOLS as readonly string[]).includes(x.name))) {
      expect(d.annotations.readOnlyHint).toBe(true);
    }
  });

  it("marks a turn untrusted after the log and memory reads only", () => {
    expect(ownToolBringsOutsideText("ppm_status")).toBe(false);
    expect(ownToolBringsOutsideText("system_resources")).toBe(false);
    expect(ownToolBringsOutsideText("jira_config_get")).toBe(false);
    expect(ownToolBringsOutsideText("ppm_logs_search")).toBe(true);
    expect(ownToolBringsOutsideText("ppm_memory_report")).toBe(true);
  });
});

describe("output budget and windows", () => {
  it("drops list entries until the answer fits, keeping the newest when asked", () => {
    const list = Array.from({ length: 400 }, (_, i) => ({ i, pad: "x".repeat(200) }));
    const out = text(boundedJson({ list }, { key: "list", list, dropFrom: "start" }));
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(SYSTEM_TOOL_MAX_BYTES);
    const parsed = JSON.parse(out);
    expect(parsed.list.at(-1).i).toBe(399);
    expect(parsed.omitted).toContain("left out");
  });

  it("defaults the window to the day before `to` and refuses what is not a date", () => {
    expect(timeWindow({ to: iso(T0) })).toEqual({ from: T0 - 86_400_000, to: T0 });
    expect(timeWindow({ from: "yesterday" })).toHaveProperty("error");
    expect(timeWindow({ from: iso(T0 + 1), to: iso(T0) })).toHaveProperty("error");
  });
});

describe("regex safety", () => {
  it.each([
    ["(a+)+$", "nested"], ["(a|ab)*", "nested"], ["(x(y*))+", "nested"], ["(\\w+)\\1", "backreferences"],
    ["(?<=a)b", "lookarounds"], ["(?=a)", "lookarounds"], ["a*b*c*d*", "unbounded"], ["x".repeat(201), "longer"], ["(", "compile"],
  ])("refuses %s", (pattern, why) => {
    expect(unsafeRegexReason(pattern)).toContain(why);
  });

  it.each(["^mem ", "tick failed: \\w+", "(?:chat|sdk) error", "[(+*]x+", "a{2,5}b", "(ab)?c", "x+?y"])("allows %s", (pattern) => {
    expect(unsafeRegexReason(pattern)).toBeNull();
  });
});

describe("ppm_logs_search", () => {
  const seed = () => writeFileSync(join(getPpmDir(), "ppm.log"), [
    logLine(0, "INFO", "supervisor", "Server started (PID 41)"),
    logLine(10, "ERROR", "chat", `turn failed key ${SECRETS[0]} session=${SECRETS[6]}`),
    "    at run (C:\\Users\\victor\\ppm\\src\\chat.ts:10)\n",
    logLine(20, "WARN", "jira", `GET https://x.atlassian.net/rest?token=${SECRETS[2]} as ${SECRETS[4]}`),
    logLine(30, "INFO", "sdk", `cwd ${SECRETS[5]}\\Projects\\${SECRETS[7]} Authorization: Bearer ${SECRETS[2]}`),
    logLine(40, "ERROR", "git", `push failed ${SECRETS[1]} password=${SECRETS[3]}`),
    logLine(50, "DEBUG", "fs", "watch tick"),
  ].join(""));

  it("returns lines with every seeded secret and identifier taken out", async () => {
    seed();
    upsertProject("/tmp/acme", SECRETS[7]!);
    const r = await ppmLogsSearch({ from: iso(T0 - 1000), to: iso(T0 + 3_600_000), level: "debug" });
    const out = text(r);
    for (const s of SECRETS) expect(out).not.toContain(s);
    const body = JSON.parse(out);
    expect(body.lines.map((l: { tag: string }) => l.tag)).toEqual(["supervisor", "chat", "jira", "sdk", "git", "fs"]);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("<project>");
    expect(out).toContain("4b8e2c1a"); // a chat id keeps its first eight characters
  });

  it("filters by level, literal pattern, regex and the end of the window", async () => {
    seed();
    const errors = json(await ppmLogsSearch({ from: iso(T0 - 1000), to: iso(T0 + 3_600_000), level: "error" }));
    expect(errors.lines.map((l: { tag: string }) => l.tag)).toEqual(["chat", "git"]);
    const literal = json(await ppmLogsSearch({ from: iso(T0 - 1000), to: iso(T0 + 3_600_000), pattern: "PUSH FAILED" }));
    expect(literal.lines).toHaveLength(1);
    // A literal pattern's regex characters are text, not syntax.
    expect(json(await ppmLogsSearch({ from: iso(T0 - 1000), to: iso(T0 + 3_600_000), pattern: "(PID 41)" })).lines).toHaveLength(1);
    const rx = json(await ppmLogsSearch({ from: iso(T0 - 1000), to: iso(T0 + 3_600_000), pattern: "^(?:chat|git) ", regex: true }));
    expect(rx.lines).toHaveLength(2);
    const early = json(await ppmLogsSearch({ from: iso(T0 - 1000), to: iso(T0 + 15_000) }));
    expect(early.lines.map((l: { tag: string }) => l.tag)).toEqual(["supervisor", "chat"]);
    expect(isError(await ppmLogsSearch({ pattern: "(a+)+", regex: true }))).toBe(true);
    expect(isError(await ppmLogsSearch({ limit: 501 }))).toBe(true);
    expect(isError(await ppmLogsSearch({ source: "nowhere" }))).toBe(true);
  });

  it("cuts each line and keeps the answer under the budget", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => logLine(i, "INFO", "chat", `row ${i} ${"y".repeat(900)}`));
    writeFileSync(join(getPpmDir(), "ppm.log"), lines.join(""));
    const out = text(await ppmLogsSearch({ from: iso(T0 - 1000), to: iso(T0 + 3_600_000), limit: 500 }));
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(SYSTEM_TOOL_MAX_BYTES);
    const body = JSON.parse(out);
    expect(body.lines.at(-1).text.startsWith("row 299")).toBe(true);
    expect(body.lines[0].text.length).toBeLessThan(560);
  });
});

describe("ppm_memory_report", () => {
  const sample = (min: number, pid: number, privateMB: number) => JSON.stringify({
    t: iso(T0 + min * 60_000), role: "server", pid, upMin: min, rssMB: 300, privateMB, heapMB: 90, externalMB: 12, handles: 900,
    children: { count: 3, privateMB: 50, byName: { claude: { n: 3, mb: 50 } } }, gauges: { ["x".repeat(40)]: 1 },
  });

  it("finds the window in a large log by bisection and thins it to 40 rows", async () => {
    const path = join(getPpmDir(), "mem-diag.log");
    const lines: string[] = [];
    for (let m = 0; m < 3000; m++) lines.push(sample(m, m < 1500 ? 10 : 20, 400 + m));
    lines.splice(100, 0, JSON.stringify({ t: iso(T0 + 100 * 60_000), alert: "private-bytes", privateMB: 9 }));
    writeFileSync(path, `${lines.join("\n")}\n`);
    const direct = await readDiagWindow(path, T0 + 1000 * 60_000, T0 + 2000 * 60_000);
    expect(direct.samples).toHaveLength(1001);
    expect(direct.samples[0]!.t).toBe(iso(T0 + 1000 * 60_000));

    appendFileSync(join(getPpmDir(), "ppm.log"), logLine(1200 * 60, "WARN", "mem", `server private bytes crossed 2048MB at ${SECRETS[5]}\\x`));
    const r = json(await ppmMemoryReport({ from: iso(T0 + 1000 * 60_000), to: iso(T0 + 2000 * 60_000) }, undefined, T0 + 3000 * 60_000));
    expect(r.samplesInWindow).toBe(1001);
    expect(r.rows).toHaveLength(40);
    expect(r.rows[0]).toEqual({ t: iso(T0 + 1000 * 60_000), pid: 10, upMin: 1000, rss: 300, private: 1400, heap: 90, external: 12, handles: 900 });
    expect(r.runs.map((x: { pid: number }) => x.pid)).toEqual([10, 20]);
    expect(r.runs[1].privatePeak).toBe(2400);
    expect(r.memWarnings).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(SECRETS[5]);
  });

  it("says when PPM_MEM_DIAG never wrote samples", async () => {
    const r = json(await ppmMemoryReport({}));
    expect(r.samplesInWindow).toBe(0);
    expect(r.note).toContain("PPM_MEM_DIAG=1");
  });

  it("keeps first and last when thinning", () => {
    expect(downSample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4)).toEqual([1, 4, 7, 10]);
    expect(downSample([1, 2], 40)).toEqual([1, 2]);
  });
});

describe("ppm_status", () => {
  const deps = (over: Partial<StatusDeps> = {}): StatusDeps => ({
    now: () => T0, pid: 4242, ppid: 77, uptimeSec: () => 3600, moduleDir: "/opt/ppm/src/services/assistant-mcp",
    execPath: "/usr/bin/bun", status: () => ({ supervisorPid: 77 }), isAlive: () => true, restarts: async () => [T0 - 3_600_000],
    ...over,
  });

  it("answers version, server, profile, supervisor and runtime", async () => {
    const r = json(await ppmStatus(deps()));
    expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.server).toEqual({ pid: 4242, startedAt: iso(T0 - 3_600_000), uptimeSec: 3600, lastRestartLogged: iso(T0 - 3_600_000) });
    expect(r.supervisor).toEqual({ present: true, pid: 77 });
    expect(r.database.profile).toBe("default");
    expect(r.database.file).not.toMatch(/[\\/]/);
    expect(typeof r.runtime.bun).toBe("string");
  });

  it("does not count a supervisor that is not this server's parent", async () => {
    expect(json(await ppmStatus(deps({ status: () => ({ supervisorPid: 99 }) }))).supervisor).toEqual({ present: false });
  });

  it("names the install folder of a source install and of a compiled binary", () => {
    expect(installLocation(join("/opt", "ppm", "src", "services", "assistant-mcp"), "/x")).toEqual({ kind: "source", folder: resolve("/opt", "ppm") });
    expect(installLocation("B:/~BUN/root/src", join("/opt", "ppm", "ppm"))).toEqual({ kind: "binary", folder: join("/opt", "ppm") });
  });
});
