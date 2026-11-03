/**
 * What a chat leaves running is stopped, end to end: PPM's own `query()` drives the REAL Claude
 * CLI against a fake Anthropic API that turns the prompt's `RUN:` lines into Bash tool calls,
 * with a stdio MCP server configured, on the real systemd user manager.
 *
 *   PPM_HOME=$(mktemp -d) bun tests/e2e/chat-session-processes-e2e.ts
 *
 * 1. Every command, and the MCP server, runs in a scope under the session's slice, and the CLI
 *    still gets each command's output and exit code.
 * 2. What a command leaves behind — `setsid`, `nohup env -i … &`, `systemd-run --user` — stays
 *    in the slice however it detached.
 * 3. An idle sweep stops all of it, and spares the MCP server, which belongs to the live CLI.
 * 4. Closing the chat's CLI empties the slice.
 *
 * Linux with a systemd user manager only; anywhere else it says so and exits 0.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { query } from "../../src/providers/claude-cli-process-group.ts";
import {
  initChatSessionProcesses, registerLeftoverSweeper, sweepLeftovers, type SweepDeps,
} from "../../src/services/chat-session-processes/session-processes.service.ts";
import { instanceSliceName, instanceTag, sessionSliceName } from "../../src/services/chat-session-processes/session-slice.ts";
import { startBashScriptApi } from "./fixtures/bash-script-anthropic-api.ts";

if (!process.env.PPM_HOME) {
  console.error("Run with PPM_HOME set to a scratch directory: PPM_HOME=$(mktemp -d) bun tests/e2e/chat-session-processes-e2e.ts");
  process.exit(2);
}

const MIN = 60_000;
const MCP_SERVER = resolve(import.meta.dir, "fixtures/idle-mcp-server.ts");
const sandbox = mkdtempSync(join(tmpdir(), "ppm-chat-procs-e2e-"));
const instanceDb = join(sandbox, "ppm.db");
const deps: SweepDeps = { activity: () => ({ busy: false }) };

if (!(await initChatSessionProcesses({ dbPath: instanceDb, idleMinutes: () => 30 }))) {
  console.log("SKIP: this host cannot run systemd-run --user --scope");
  process.exit(0);
}
const unregister = registerLeftoverSweeper(deps);

const instance = instanceTag(instanceDb);
const sessionId = crypto.randomUUID();
const slice = sessionSliceName(instance, sessionId)!;
const tag = String(100_000 + Math.floor(Math.random() * 800_000));
const agentUnit = `ppm-e2e-agent-${tag}.service`;
const api = startBashScriptApi();
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
};

let release = () => {};
const released = new Promise<void>((r) => (release = r));
const PROMPT = [
  "RUN: cat /proc/self/cgroup",
  "RUN: echo kept-output; exit 3",
  `RUN: (setsid sleep ${tag}1 &); nohup env -i /usr/bin/sleep ${tag}2 >/dev/null 2>&1 & systemd-run --user --quiet --unit=${agentUnit} sleep ${tag}3; echo spawned`,
].join("\n");

async function* messages() {
  yield { type: "user" as const, message: { role: "user" as const, content: PROMPT }, parent_tool_use_id: null, session_id: sessionId };
  await released;
}

const home = join(sandbox, "home");
const project = join(sandbox, "project");
await Bun.$`mkdir -p ${home} ${project}`.quiet();
const env: Record<string, string> = {
  HOME: home, USER: process.env.USER ?? "", SHELL: "/bin/bash",
  PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR!,
  ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "sk-ant-api03-fake-e2e", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
if (process.env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;

try {
  const q = query({
    prompt: messages(),
    options: {
      sessionId, cwd: project, env, settingSources: [], maxTurns: 12,
      ...(process.env.PPM_E2E_CLAUDE && { pathToClaudeCodeExecutable: process.env.PPM_E2E_CLAUDE }),
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      mcpServers: { idle: { type: "stdio", command: process.execPath, args: [MCP_SERVER] } },
    },
  });
  const toolResults: { text: string; isError: boolean }[] = [];
  let resultSubtype = "";
  let mcpStatus = "";
  // Not `for await`: leaving that loop would close the query, and the CLI with it.
  const stream = (q as AsyncIterable<any>)[Symbol.asyncIterator]();
  for (let next = await stream.next(); !next.done; next = await stream.next()) {
    const msg = next.value;
    if (msg.type === "system" && msg.subtype === "init") mcpStatus = JSON.stringify(msg.mcp_servers);
    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content) {
        if (b.type !== "tool_result") continue;
        const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
        toolResults.push({ text, isError: !!b.is_error });
      }
    }
    if (msg.type === "result") { resultSubtype = msg.subtype; break; }
  }
  check("the turn ran every scripted command", resultSubtype === "success" && toolResults.length === 3, `${resultSubtype}, ${toolResults.length} results`);

  const cgroup = toolResults[0]?.text ?? "";
  check(
    "a command runs in a scope of its own under the session's slice",
    new RegExp(`/${instanceSliceName(instance)}/${slice}/ppmcmd-[0-9a-f-]{36}\\.scope$`).test(cgroup.trim()),
    cgroup,
  );
  check(
    "the CLI still gets the command's output and exit code",
    !!toolResults[1]?.isError && /Exit code 3/.test(toolResults[1].text) && toolResults[1].text.includes("kept-output"),
    JSON.stringify(toolResults[1]),
  );

  const left = [1, 2, 3].map((n) => pidOf(`sleep\0${tag}${n}`));
  check(
    "what a command left behind stays in the slice, however it detached",
    left.every((pid) => pid > 0 && cgroupOf(pid).includes(`/${slice}/`)),
    left.map((pid) => `${pid}: ${cgroupOf(pid)}`).join("\n     "),
  );
  check("a unit the agent started itself is in the slice", unitSlice(agentUnit) === slice, unitSlice(agentUnit));

  // The path as an argument of its own: the CLI's own command line names it inside --mcp-config.
  const mcp = pidOf(`\0${MCP_SERVER}\0`);
  check("the MCP server runs under the session's slice", mcp > 0 && cgroupOf(mcp).includes(`/${slice}/ppmcmd-`), `${mcp}: ${cgroupOf(mcp)} (CLI said ${mcpStatus})`);

  const t0 = Date.now();
  sweepLeftovers(deps, "idle", t0);
  sweepLeftovers(deps, "idle", t0 + 30 * MIN);
  const swept = await until(() => left.every((pid) => !running(pid)) && !unitActive(agentUnit));
  check("an idle sweep stops everything the chat left running", swept, left.filter(running).join(", "));
  await Bun.sleep(500);
  check("and spares the MCP server of the live CLI", running(mcp));

  release();
  q.close();
  check("closing the chat's CLI empties the slice", await until(() => !populated()), "still populated");
} catch (e) {
  check("the run finished", false, (e as Error).stack);
} finally {
  unregister();
  api.stop();
  Bun.spawnSync(["systemctl", "--user", "stop", instanceSliceName(instance)]);
  rmSync(sandbox, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);

function pidOf(cmdlinePart: string): number {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (readFileSync(`/proc/${name}/cmdline`, "utf8").includes(cmdlinePart)) return Number(name);
    } catch {}
  }
  return 0;
}

function cgroupOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find((l) => l.startsWith("0::"))?.slice(3) ?? "";
  } catch {
    return "";
  }
}

function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat[stat.lastIndexOf(")") + 2] !== "Z";
  } catch {
    return false;
  }
}

function unitSlice(unit: string): string {
  return Bun.spawnSync(["systemctl", "--user", "show", "-p", "Slice", "--value", unit]).stdout.toString().trim();
}

function unitActive(unit: string): boolean {
  return Bun.spawnSync(["systemctl", "--user", "is-active", "--quiet", unit]).exitCode === 0;
}

function populated(): boolean {
  const appSlice = Bun.spawnSync(["systemctl", "--user", "show", "-p", "ControlGroup", "--value", "app.slice"]).stdout.toString().trim();
  try {
    const events = readFileSync(join("/sys/fs/cgroup", appSlice, "app-ppmchat.slice", instanceSliceName(instance), slice, "cgroup.events"), "utf8");
    return /^populated 1$/m.test(events);
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(100);
  }
  return cond();
}
