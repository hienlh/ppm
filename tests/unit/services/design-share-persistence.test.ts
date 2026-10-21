/**
 * Share links and their threads survive a PPM restart. Each step runs in a new `bun` process
 * on the same isolated PPM_HOME and project, so nothing in memory carries over: the second
 * process opens the database file again and reads the share secret from disk.
 *
 * The control: with the secret file gone, the same code no longer opens anything, so the
 * code that keeps working is derived from what was persisted, not from something every
 * process would recompute the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "design-share-persistence-process.ts");

interface Codes { kept: { id: string; path: string; snapshotId: string }; revoked: { id: string; path: string } }
interface Observed {
  resolved: { id: string; snapshotId: string; label: string } | null;
  revokedResolves: boolean;
  listed: { id: string; label: string; status: string; path: string | null; expiresAt: number | null }[];
  threads: { body: string; author: unknown; mine: boolean; replies: { body: string; author: unknown; mine: boolean }[] }[] | null;
}

describe("design share links across a restart", () => {
  let ppmHome: string;
  let project: string;

  /** One PPM process: runs a step and answers what it printed. */
  async function processStep<T>(...args: string[]): Promise<T> {
    const { PPM_ALLOW_PROD_DB: _never, ...env } = process.env;
    const child = Bun.spawn([process.execPath, SCRIPT, ...args], { env: { ...env, PPM_HOME: ppmHome }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const line = out.split("\n").find((l) => l.startsWith("RESULT "));
    if (code !== 0 || !line) throw new Error(`step ${args[0]} exited ${code}: ${err || out}`);
    return JSON.parse(line.slice("RESULT ".length)) as T;
  }

  beforeAll(() => {
    ppmHome = realpathSync(mkdtempSync(join(tmpdir(), "ppm-share-persist-home-")));
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-share-persist-project-")));
  });
  afterAll(() => {
    rmSync(ppmHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  let codes: Codes;
  let first: Observed;

  it("a new process opens the same code, at the same address, with its threads", async () => {
    codes = await processStep<Codes>("create", project);
    expect(existsSync(join(ppmHome, "ppm.db"))).toBe(true);
    expect(existsSync(join(ppmHome, "design-share.key"))).toBe(true);

    first = await processStep<Observed>("observe", project, JSON.stringify(codes));
    expect(first.resolved).toEqual({ id: codes.kept.id, snapshotId: codes.kept.snapshotId, label: "Client A" });
    const kept = first.listed.find((l) => l.id === codes.kept.id)!;
    // Re-derived from the persisted secret: the address the owner copied before the restart.
    expect(kept).toMatchObject({ label: "Client A", status: "active", path: codes.kept.path });
    expect(kept.expiresAt).toBeGreaterThan(Date.now());
    expect(first.threads).toEqual([{
      body: "Bigger headline", author: { kind: "guest", name: "Ann" }, mine: true,
      replies: [
        { body: "Agreed", author: { kind: "guest", name: "Bob" }, mine: false },
        { body: "Done", author: { kind: "owner" }, mine: false },
      ],
    }]);
  }, 60_000);

  it("a revoked link stays revoked", () => {
    expect(first.revokedResolves).toBe(false);
    expect(first.listed.find((l) => l.id === codes.revoked.id)).toMatchObject({ status: "revoked", path: null });
  });

  it("a second restart answers the same again", async () => {
    expect(await processStep<Observed>("observe", project, JSON.stringify(codes))).toEqual(first);
  }, 60_000);

  it("control: without the secret file the old code opens nothing", async () => {
    rmSync(join(ppmHome, "design-share.key"));
    const after = await processStep<Observed>("observe", project, JSON.stringify(codes));
    expect(after.resolved).toBeNull();
    expect(after.listed.find((l) => l.id === codes.kept.id)).toMatchObject({ status: "needs-new-code", path: null });
  }, 60_000);
});
