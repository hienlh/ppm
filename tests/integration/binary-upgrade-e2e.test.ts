/**
 * Maximal simulated end-to-end binary upgrade: drives the REAL pipeline
 * (checksum verify → extract → payload-root detect → atomic swap) against a
 * runtime-built tar.gz fixture and a mocked network. Only the actual
 * selfReplace()/process re-exec is out of scope. Global fetch is stubbed to a
 * throw so any real network call fails the test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import "../../tests/test-setup.ts";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { applyBinaryUpgrade } from "../../src/services/binary-upgrade-apply.ts";
import { downloadAndExtract, headCheckAsset, type FetchFn } from "../../src/services/binary-upgrade-download.ts";
import { swapBinaryAndWeb, cleanupStaleBinaryUpgradeArtifacts } from "../../src/services/binary-upgrade-swap.ts";

let root: string;
let tarBytes: Buffer;
let tarHash: string;
const LATEST = "9.9.9";
const ARTIFACT = "ppm-linux-x64.tar.gz";
const ASSET_URL = `https://github.com/hienlh/ppm/releases/download/v${LATEST}/ppm-linux-x64.tar.gz`;
const SUMS_URL = `https://github.com/hienlh/ppm/releases/download/v${LATEST}/SHA256SUMS`;

async function buildTarGz(dir: string): Promise<Buffer> {
  const pkg = mkdtempSync(join(dir, "pkg-"));
  writeFileSync(join(pkg, "ppm"), "NEW-BINARY");
  mkdirSync(join(pkg, "web"), { recursive: true });
  writeFileSync(join(pkg, "web", "index.html"), "new");
  const out = join(dir, "fixture.tar.gz");
  const proc = Bun.spawn({ cmd: ["tar", "-czf", out, "-C", pkg, "."], stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  return Buffer.from(readFileSync(out));
}

function makeFetch(sumsText: string): FetchFn {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    if (u === ASSET_URL) return new Response(tarBytes);
    if (u === SUMS_URL) return new Response(sumsText);
    return new Response(null, { status: 404 });
  }) as unknown as FetchFn;
}

/** Fresh fake install dir with an OLD binary + web. */
function makeInstall(): { execPath: string; webDir: string } {
  const bin = mkdtempSync(join(root, "install-"));
  mkdirSync(join(bin, "web"), { recursive: true });
  writeFileSync(join(bin, "ppm"), "OLD-BINARY");
  writeFileSync(join(bin, "web", "old.html"), "old");
  return { execPath: join(bin, "ppm"), webDir: join(bin, "web") };
}

const realFetch = globalThis.fetch;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ppm-e2e-"));
  tarBytes = await buildTarGz(root);
  tarHash = createHash("sha256").update(tarBytes).digest("hex");
});
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

// Prove nothing touches the real network.
beforeEach(() => { globalThis.fetch = (() => { throw new Error("real network call!"); }) as never; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("binary upgrade — simulated e2e (linux/tar.gz)", () => {
  function deps(sumsText: string, install: { execPath: string; webDir: string }) {
    const fetchFn = makeFetch(sumsText);
    return {
      checkFn: async () => ({ available: true, current: "1.0.0", latest: LATEST }),
      headCheckFn: (url: string) => headCheckAsset(url, fetchFn),
      downloadFn: (o: Parameters<typeof downloadAndExtract>[0]) => downloadAndExtract({ ...o, fetchFn }),
      swapFn: swapBinaryAndWeb,
      execPath: install.execPath,
      platform: "linux" as NodeJS.Platform,
      arch: "x64",
    };
  }

  it("happy path: download→verify→extract→swap; new files in place", async () => {
    const install = makeInstall();
    const res = await applyBinaryUpgrade(deps(`${tarHash}  ${ARTIFACT}\n`, install));
    expect(res).toEqual({ success: true, newVersion: LATEST });
    expect(readFileSync(install.execPath, "utf8")).toBe("NEW-BINARY");
    expect(existsSync(join(install.webDir, "index.html"))).toBe(true);
    expect(existsSync(join(install.webDir, "old.html"))).toBe(false);
  });

  it("negative: checksum mismatch aborts, install untouched", async () => {
    const install = makeInstall();
    const res = await applyBinaryUpgrade(deps(`${"0".repeat(64)}  ${ARTIFACT}\n`, install));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/checksum/);
    expect(readFileSync(install.execPath, "utf8")).toBe("OLD-BINARY"); // unchanged
    expect(existsSync(join(install.webDir, "old.html"))).toBe(true);
  });
});

describe("binary upgrade — Windows swap + boot cleanup (acceptance #4)", () => {
  it("nested-zip layout swaps via .old then cleanup removes it", () => {
    // Simulate an extracted nested payload (ppm-windows-x64/ppm.exe + web/).
    const payload = join(mkdtempSync(join(root, "winpay-")), "ppm-windows-x64");
    mkdirSync(join(payload, "web"), { recursive: true });
    writeFileSync(join(payload, "ppm.exe"), "NEW-EXE");
    writeFileSync(join(payload, "web", "index.html"), "new");

    const bin = mkdtempSync(join(root, "wininstall-"));
    mkdirSync(join(bin, "web"), { recursive: true });
    writeFileSync(join(bin, "ppm.exe"), "OLD-EXE");
    const execPath = join(bin, "ppm.exe");

    swapBinaryAndWeb(payload, execPath, join(bin, "web"), "win32");
    expect(readFileSync(execPath, "utf8")).toBe("NEW-EXE");
    expect(existsSync(execPath + ".old")).toBe(true);

    // Next boot cleanup removes the leftover .old.
    cleanupStaleBinaryUpgradeArtifacts(dirname(execPath), "win32");
    expect(existsSync(execPath + ".old")).toBe(false);
  });
});
