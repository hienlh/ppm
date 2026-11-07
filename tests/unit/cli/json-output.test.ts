import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// `--json` output is what scripts and AI agents (the PPM skill sends them here) parse, so the
// version banner every other command starts with must not come before it on stdout.

const REPO = resolve(import.meta.dir, "../../..");
const home = mkdtempSync(join(tmpdir(), "ppm-json-out-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

async function ppm(...args: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn([process.execPath, join(REPO, "src/index.ts"), ...args], {
    cwd: REPO, env: { ...process.env, PPM_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { out, code };
}

describe("ppm <command> --json", () => {
  it("prints the JSON alone on stdout", async () => {
    const { out, code } = await ppm("status", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ running: false, healthy: false });
  }, 30_000);

  it("keeps the version banner on output meant for a person", async () => {
    const { out } = await ppm("status");
    expect(out).toContain("PPM v");
  }, 30_000);
});
