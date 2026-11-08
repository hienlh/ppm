/**
 * A throwaway PPM for end-to-end runs: a compiled binary, a scratch PPM_HOME, a loopback port,
 * and an environment with nothing of the shell that started it — no CLAUDE_* (a real turn
 * would inherit them) and no NOTIFY_SOCKET (whose inheritance once let a test stop the real
 * PPM). It runs under its own supervisor, as an install does. The supervisor opens a public
 * tunnel whatever its arguments say (`--share` is a no-op), and this instance runs with no auth,
 * so `init` switches the tunnel off and `start` refuses to run unless the database and the log
 * both say it is off. Every pid it signals is first checked to carry this instance's PPM_HOME.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ApiAnswer { status: number; text: string; json: any }

export class ScratchPpm {
  readonly dir = mkdtempSync(join(tmpdir(), "ppm-sched-e2e-"));
  readonly home = join(this.dir, "home");
  readonly project = join(this.dir, "proj");
  readonly env: Record<string, string>;
  port = 0;

  constructor(readonly bin: string) {
    mkdirSync(this.home);
    mkdirSync(this.project);
    mkdirSync(join(this.dir, "empty"));
    this.env = { HOME: process.env.HOME!, PATH: process.env.PATH!, LANG: "C.UTF-8", PPM_HOME: this.home };
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  cli(...args: string[]): { code: number; out: string } {
    const r = Bun.spawnSync([this.bin, ...args], { env: this.env, cwd: this.dir, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() };
  }

  async api(method: string, path: string, body?: unknown): Promise<ApiAnswer> {
    const res = await fetch(`${this.base}/api${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json };
  }

  /** The scratch database, read only; the server keeps writing to it. */
  query<T = any>(sql: string, ...params: unknown[]): T[] {
    const db = new Database(join(this.home, "ppm.db"), { readonly: true });
    try {
      return db.query(sql).all(...(params as never[])) as T[];
    } finally {
      db.close();
    }
  }

  /** A write to the scratch database — the only database this class can name. */
  exec(sql: string, ...params: unknown[]): void {
    const db = new Database(join(this.home, "ppm.db"));
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.query(sql).run(...(params as never[]));
    } finally {
      db.close();
    }
  }

  status(): { pid?: number; supervisorPid?: number } {
    try { return JSON.parse(readFileSync(join(this.home, "status.json"), "utf8")); } catch { return {}; }
  }

  /** `ppm init` against the scratch home, importing no project, on a free port, with no tunnel. */
  async init(): Promise<void> {
    this.port = await freePort();
    for (const args of [
      ["init", "-y", "--no-auth", "--scan", join(this.dir, "empty"), "--port", String(this.port)],
      ["config", "set", "tunnel.enabled", "false"],
    ]) {
      const r = this.cli(...args);
      if (r.code !== 0) throw new Error(`${args[0]} failed: ${r.out}`);
    }
  }

  async start(): Promise<void> {
    const tunnel = JSON.parse(this.query<{ value: string }>("SELECT value FROM config WHERE key = 'tunnel'")[0]?.value ?? "{}");
    if (tunnel.enabled !== false) throw new Error("the scratch PPM's tunnel is not switched off; not starting it");
    Bun.spawn(["setsid", this.bin, "__supervise__", String(this.port), "127.0.0.1"], {
      env: this.env, cwd: this.dir, stdin: "ignore",
      stdout: Bun.file(join(this.dir, "supervisor.out")), stderr: Bun.file(join(this.dir, "supervisor.err")),
    });
    await this.waitHealthy();
    const log = readFileSync(join(this.home, "ppm.log"), "utf8");
    if (!log.includes("Tunnel off (tunnel.enabled = false)") || this.ours().some((p) => p.cmdline.includes("cloudflared"))) {
      await this.stop();
      throw new Error("the scratch PPM started a tunnel; stopped it");
    }
  }

  async waitHealthy(ms = 60_000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const pid = this.status().pid;
      try {
        if (pid && isAlive(pid) && (await fetch(`${this.base}/api/health`)).ok) return;
      } catch { /* not up yet */ }
      await Bun.sleep(200);
    }
    throw new Error(`the scratch PPM on ${this.port} did not come up in ${ms / 1000} s`);
  }

  /** SIGKILL the server — the supervisor starts a new one — and wait for that one to answer. */
  async killServer(): Promise<{ old: number; next: number }> {
    const old = this.status().pid!;
    this.signal(old, "SIGKILL");
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const next = this.status().pid;
      if (next && next !== old && isAlive(next)) {
        await this.waitHealthy();
        return { old, next };
      }
      await Bun.sleep(100);
    }
    throw new Error("the supervisor did not start a new server");
  }

  /** Live script processes of this instance (a child carries its run token and our PPM_HOME). */
  scriptChildren(): number[] {
    return this.ours().filter((p) => p.env.includes("PPM_SCHEDULE_RUN=")).map((p) => p.pid);
  }

  /** Stop the supervisor, kill anything of ours still alive, and remove the scratch directory. */
  async stop(): Promise<void> {
    const sup = this.status().supervisorPid;
    if (sup && isAlive(sup)) this.signal(sup, "SIGTERM");
    const until = Date.now() + 15_000;
    while (Date.now() < until && this.ours().length) await Bun.sleep(200);
    for (const p of this.ours()) this.signal(p.pid, "SIGKILL");
    await Bun.sleep(300);
    rmSync(this.dir, { recursive: true, force: true });
  }

  private signal(pid: number, sig: NodeJS.Signals): void {
    if (!readEnviron(pid).split("\0").includes(`PPM_HOME=${this.home}`)) throw new Error(`pid ${pid} is not this scratch PPM's; not signalling it`);
    process.kill(pid, sig);
  }

  private ours(): Array<{ pid: number; env: string; cmdline: string }> {
    const out: Array<{ pid: number; env: string; cmdline: string }> = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      const env = readEnviron(Number(name));
      if (!env.split("\0").includes(`PPM_HOME=${this.home}`)) continue;
      let cmdline = "";
      try { cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8"); } catch { /* gone */ }
      out.push({ pid: Number(name), env, cmdline });
    }
    return out;
  }
}

export function isAlive(pid: number): boolean {
  if (!existsSync(`/proc/${pid}`)) return false;
  try {
    // A zombie has exited; only its parent's wait is missing.
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

function readEnviron(pid: number): string {
  try { return readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { return ""; }
}

async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = 47000 + Math.floor(Math.random() * 1000);
    try {
      const probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") });
      probe.stop(true);
      // The supervisor's server also binds a loopback port of its own; leave it room.
      return port;
    } catch { /* taken */ }
  }
  throw new Error("no free port");
}
