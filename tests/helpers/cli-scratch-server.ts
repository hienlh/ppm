import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Runs the real `ppm` CLI against a scratch PPM: a temp `PPM_HOME`, an optional scratch server in
 * a process of its own (`cli-scratch-server-main.ts`), and a CLI process whose environment is
 * built from an allowlist. Nothing here reads or writes the real `~/.ppm`: the parent's
 * `PPM_PROFILE`, `PPM_INSTANCE_ID`, `PPM_AI_CHAT`, `PPM_ASSISTANT_DB` and `PPM_LIVE_HOME` never
 * reach a child unless a test sets them.
 */
const ROOT = resolve(import.meta.dir, "..", "..");
const ENV_ALLOWLIST = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG"];

export function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "ppm-cli-scratch-"));
}

export function scratchEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, PPM_HOME: home, NO_COLOR: "1", ...extra };
}

export interface ScratchServer {
  port: number;
  pid: number;
  token: string;
  config(): Promise<Record<string, unknown>>;
  /** What the server broadcast on `/ws/global` so far, oldest first. */
  events(): Promise<Array<{ type?: string }>>;
  stop(): Promise<void>;
}

/** Starts a scratch server on `home` for `profile` (null: the default `ppm.db`). */
export async function startScratchServer(home: string, profile: string | null, token = `tok-${crypto.randomUUID()}`): Promise<ScratchServer> {
  const proc = Bun.spawn([process.execPath, join(ROOT, "tests", "helpers", "cli-scratch-server-main.ts"), profile ?? "-", token], {
    cwd: ROOT, env: scratchEnv(home), stdout: "pipe", stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  let out = "";
  const deadline = Date.now() + 30_000;
  while (!/READY (\d+)/.test(out)) {
    if (Date.now() > deadline) throw new Error(`scratch server did not start: ${out}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`scratch server exited: ${out}${await new Response(proc.stderr).text()}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const port = Number(/READY (\d+)/.exec(out)![1]);
  const read = async <T>(what: string): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/__scratch/${what}`, { headers: { Authorization: `Bearer ${token}` } });
    return ((await res.json()) as { data: T }).data;
  };
  return {
    port, pid: proc.pid, token,
    config: () => read<Record<string, unknown>>("config"),
    events: () => read<Array<{ type?: string }>>("events"),
    async stop() {
      proc.kill();
      await proc.exited;
    },
  };
}

/** Runs `ppm <args>` from source in `home`, with only `env` added to the allowlist. */
export async function runCli(home: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(ROOT, "src", "index.ts"), ...args], {
    cwd: ROOT, env: scratchEnv(home, env), stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}
