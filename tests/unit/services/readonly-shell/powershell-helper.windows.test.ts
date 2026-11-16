/**
 * The PowerShell parser helper: its lifecycle against a scripted child (runs everywhere), then
 * the real helper against the corpus, its speed and its memory (skipped, with the reason printed,
 * where no PowerShell is installed).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PowerShellAstHelper, findPowerShellExecutable, type AstHelperChild } from "../../../../src/services/assistant/readonly-shell/powershell-ast-helper.ts";
import { classifyPowerShellCommand } from "../../../../src/services/assistant/readonly-shell/powershell-readonly-classifier.ts";
import type { PsParseReply } from "../../../../src/services/assistant/readonly-shell/powershell-ast-types.ts";
import { createCorpusFixture, type CorpusFixture } from "./adversarial-bash-corpus.ts";
import { POWERSHELL_CORPUS, materialize, powerShellCorpusContext } from "./adversarial-powershell-corpus.ts";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, enabled: () => false } as never;
const TREE = { t: "ScriptBlockAst" };

/** A child that greets, then answers each request with what `answer` returns (or nothing). */
function scriptedChild(answer: (id: string) => string | null = (id) => JSON.stringify({ id, ok: true, count: 1, ast: TREE })) {
  let push: (s: string) => void = () => {};
  let exit: (code: number) => void = () => {};
  const child = {
    pid: 4242,
    killed: false,
    written: [] as string[],
    stdout: new ReadableStream<Uint8Array>({ start: (c) => { push = (s) => c.enqueue(new TextEncoder().encode(s)); } }),
    exited: new Promise<number>((resolve) => { exit = resolve; }),
    stdin: { write: (line: string) => { child.written.push(line); const reply = answer(line.split(" ")[0]!); if (reply !== null) queueMicrotask(() => push(`${reply}\n`)); } },
    kill: () => { child.killed = true; exit(1); },
    say: (s: string) => push(s),
    die: () => exit(1),
  };
  queueMicrotask(() => push('{"ready":true,"ps":"5.1.0"}\r\n'));
  return child;
}

function helperWith(children: ReturnType<typeof scriptedChild>[], opts: Partial<ConstructorParameters<typeof PowerShellAstHelper>[0]> = {}) {
  let clock = 0;
  const spawned: string[][] = [];
  const helper = new PowerShellAstHelper({
    executable: () => "C:\\pwsh.exe",
    spawn: (argv) => { spawned.push(argv); const c = children.shift(); if (!c) throw new Error("no more children"); return c as unknown as AstHelperChild; },
    now: () => clock,
    log: quiet,
    ...opts,
  });
  return { helper, spawned, advance: (ms: number) => { clock += ms; } };
}

describe("helper lifecycle", () => {
  it("starts nothing until asked, then serves requests in order from one child", async () => {
    const child = scriptedChild();
    const { helper, spawned } = helperWith([child]);
    expect(spawned).toHaveLength(0);
    const [a, b] = await Promise.all([helper.parse("Get-Date"), helper.parse("Get-Process")]);
    expect(a).toEqual({ ok: true, count: 1, ast: TREE, psVersion: "5.1.0" } as PsParseReply);
    expect(b.ok).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.slice(1, 5)).toEqual(["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand"]);
    expect(child.written.map((l) => Buffer.from(l.trim().split(" ")[1]!, "base64").toString("utf16le"))).toEqual(["Get-Date", "Get-Process"]);
    helper.stop();
  });

  it("fails a parse that hangs, kills the child and holds off the restart", async () => {
    const hung = scriptedChild(() => null);
    const { helper, spawned, advance } = helperWith([hung, scriptedChild()], { requestTimeoutMs: 30, backoffBaseMs: 1000 });
    expect((await helper.parse("Get-Date")).ok).toBe(false);
    expect(hung.killed).toBe(true);
    expect((await helper.parse("Get-Date")).ok).toBe(false);
    expect(spawned).toHaveLength(1);
    advance(1000);
    expect((await helper.parse("Get-Date")).ok).toBe(true);
    expect(spawned).toHaveLength(2);
    helper.stop();
  });

  it("fails what waits when the child dies or writes garbage, and gives up after the restart budget", async () => {
    const crashing = scriptedChild(() => null);
    const garbled = scriptedChild(() => "not json");
    const { helper, advance } = helperWith([crashing, garbled], { maxRestarts: 2, backoffBaseMs: 1 });
    const pending = helper.parse("Get-Date");
    await Bun.sleep(5);
    crashing.die();
    expect(await pending).toEqual({ ok: false, error: "PowerShell exited" });
    advance(10);
    expect((await helper.parse("Get-Date")).ok).toBe(false);
    expect(helper.isDisabled()).toBe(true);
    advance(1_000_000);
    expect((await helper.parse("Get-Date")).ok).toBe(false);
  });

  it("keeps its child between bursts rather than respawning it", async () => {
    const first = scriptedChild();
    const { helper, spawned, advance } = helperWith([first, scriptedChild()]);
    expect((await helper.parse("Get-Date")).ok).toBe(true);
    advance(24 * 60 * 60 * 1000);
    await Bun.sleep(30);
    expect((await helper.parse("Get-Date")).ok).toBe(true);
    expect(first.killed).toBe(false);
    expect(spawned).toHaveLength(1);
    helper.stop();
    expect(first.killed).toBe(true);
  });

  it("fails without spawning when no PowerShell is installed or the spawn throws", async () => {
    const none = new PowerShellAstHelper({ executable: () => null, log: quiet, spawn: () => { throw new Error("must not spawn"); } });
    expect(await none.parse("Get-Date")).toEqual({ ok: false, error: "no PowerShell is installed" });
    const { helper } = helperWith([]);
    expect((await helper.parse("Get-Date")).ok).toBe(false);
  });

  it("picks PowerShell 7, then its preview, then Windows PowerShell, as Claude Code does", () => {
    const env = { ProgramFiles: "C:\\PF", SystemRoot: "C:\\Win" };
    const pick = (present: string[]) => findPowerShellExecutable(env, "win32", (p) => present.includes(p));
    const [seven, preview, five] = ["C:\\PF\\PowerShell\\7\\pwsh.exe", "C:\\PF\\PowerShell\\7-preview\\pwsh.exe", "C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"];
    expect(pick([five, preview, seven])).toBe(seven);
    expect(pick([five, preview])).toBe(preview);
    expect(pick([five])).toBe(five);
    expect(pick([])).toBeNull();
  });
});

const exe = findPowerShellExecutable();
if (!exe) console.log("[powershell-helper] skipping the live helper tests: no PowerShell is installed on this host");

describe.skipIf(!exe)("live helper", () => {
  let fx: CorpusFixture;
  let helper: PowerShellAstHelper;

  beforeAll(() => {
    fx = createCorpusFixture();
    helper = new PowerShellAstHelper({ log: quiet, requestTimeoutMs: 10_000 });
  });

  afterAll(() => {
    helper.stop();
    fx.cleanup();
  });

  it("starts cold and parses warm within budget", async () => {
    const t0 = performance.now();
    expect((await helper.parse("Get-Date")).ok).toBe(true);
    const cold = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 20; i++) expect((await helper.parse(POWERSHELL_CORPUS[i % 3]!.script)).ok).toBe(true);
    const warm = (performance.now() - t1) / 20;
    console.log(`[powershell-helper] ${exe}: cold start ${cold.toFixed(0)} ms, warm parse ${warm.toFixed(1)} ms`);
    expect(cold).toBeLessThan(5000);
    expect(warm).toBeLessThan(200);
  });

  it("gives every corpus case its expected verdict with the real parser", async () => {
    const wrong: string[] = [];
    for (const c of POWERSHELL_CORPUS) {
      const v = await classifyPowerShellCommand(materialize(c.script, fx), { ...powerShellCorpusContext(fx), ...c.ctx?.(fx) }, { helper });
      if (v.verdict !== c.expected) wrong.push(`${JSON.stringify(c.script)}: expected ${c.expected}, got ${v.verdict} — ${v.reason}`);
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  it("asks once a write follows any script it runs unasked", async () => {
    for (const c of POWERSHELL_CORPUS.filter((x) => x.expected === "readonly" && !x.ctx)) {
      for (const tail of ["; Remove-Item x", " | Out-File x", "; iex 'x'", "\n& x", " > x"]) {
        const v = await classifyPowerShellCommand(materialize(c.script + tail, fx), powerShellCorpusContext(fx), { helper });
        expect(`${c.script + tail} → ${v.verdict}`).toBe(`${c.script + tail} → ask`);
      }
    }
  }, 60_000);

  it("parses exactly as the recorded trees, when recorded by this PowerShell", async () => {
    const recorded = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "powershell-asts", "corpus.json"), "utf8")) as { psVersion: string; replies: Record<string, PsParseReply> };
    const first = await helper.parse("Get-Date");
    if (!first.ok || first.psVersion !== recorded.psVersion) {
      console.log(`[powershell-helper] recorded with ${recorded.psVersion}; this host parses with another version, so trees are not compared`);
      return;
    }
    for (const [script, reply] of Object.entries(recorded.replies)) expect(await helper.parse(script)).toEqual(reply);
  }, 60_000);

  it("keeps one child with flat memory over 1,000 parses", async () => {
    const memory = () => {
      const out = Bun.spawnSync([exe!, "-NoProfile", "-NonInteractive", "-Command", `$p = Get-Process -Id ${helper.childPid()}; "$($p.WorkingSet64) $($p.PrivateMemorySize64)"`]).stdout.toString().trim().split(" ").map(Number);
      return { ws: out[0]! / 2 ** 20, commit: out[1]! / 2 ** 20 };
    };
    expect((await helper.parse(TRACE)).ok).toBe(true);
    for (let i = 0; i < 100; i++) await helper.parse(TRACE);
    const pid = helper.childPid();
    const before = memory();
    for (let i = 0; i < 1000; i++) expect((await helper.parse(TRACE)).ok).toBe(true);
    const after = memory();
    console.log(`[powershell-helper] 1,000 parses: working set ${before.ws.toFixed(1)} → ${after.ws.toFixed(1)} MiB, commit ${before.commit.toFixed(1)} → ${after.commit.toFixed(1)} MiB`);
    expect(helper.childPid()).toBe(pid);
    expect(after.commit - before.commit).toBeLessThan(40);
  }, 120_000);
});

const TRACE = POWERSHELL_CORPUS[0]!.script;
