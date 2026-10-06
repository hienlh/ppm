import { resolve } from "node:path";

const CHILD = resolve(import.meta.dir, "../fixtures/forward-exit-child.ts");

export interface ForwardChild {
  /** The forward's public URL (the first one's, when the child started two). */
  url: string;
  /** Every forward's public URL, in the order the child started them. */
  urls: string[];
  /** Close the child's stdin, so it leaves through `process.exit`; resolves with its exit code. */
  exit(): Promise<number>;
}

/** Run tests/fixtures/forward-exit-child.ts and wait until its forward is up. */
export async function startForwardChild(args: string[]): Promise<ForwardChild> {
  // env: the PPM_HOME this test process was given, which a child would not otherwise see.
  const child = Bun.spawn([process.execPath, CHILD, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let line: string | undefined;
  while (!(line = out.split("\n").find((l) => l.startsWith("forward-up ")))) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`the forward did not come up: ${await stderr}`);
    out += decoder.decode(value, { stream: true });
  }
  const { urls } = JSON.parse(line.slice("forward-up ".length)) as { urls: string[] };
  return {
    url: urls[0]!,
    urls,
    exit() {
      child.stdin.end();
      return child.exited;
    },
  };
}

/**
 * Stop a fake transport the child's exit did not stop. Only needed off Windows: there a Bun
 * child sits in its parent's job object and ends with it, and a PID is soon another process's.
 */
export function killLeftover(pid: number): void {
  if (process.platform === "win32") return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
