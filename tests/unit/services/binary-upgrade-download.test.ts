import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  headCheckAsset,
  locatePayloadRoot,
  downloadAndExtract,
  type FetchFn,
} from "../../../src/services/binary-upgrade-download.ts";

let root: string;
let tarBytes: Buffer;
let tarHash: string;
const ARTIFACT = "ppm-linux-x64.tar.gz";
const ASSET_URL = "https://github.com/hienlh/ppm/releases/download/v9.9.9/ppm-linux-x64.tar.gz";
const SUMS_URL = "https://github.com/hienlh/ppm/releases/download/v9.9.9/SHA256SUMS";

/** Build a FLAT tar.gz (./ppm + ./web/index.html) mirroring release.sh. */
async function buildTarGz(dir: string, withWeb = true): Promise<Buffer> {
  const pkg = mkdtempSync(join(dir, "pkg-"));
  writeFileSync(join(pkg, "ppm"), "NEW-BINARY");
  if (withWeb) {
    mkdirSync(join(pkg, "web"), { recursive: true });
    writeFileSync(join(pkg, "web", "index.html"), "new");
  }
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}.tar.gz`);
  const proc = Bun.spawn({ cmd: ["tar", "-czf", out, "-C", pkg, "."], stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  return Buffer.from(readFileSync(out));
}

/** fetchFn serving fixtures. `sumsHashOverride` forces a wrong/absent hash. */
function makeFetch(opts?: { sumsText?: string; head?: number }): FetchFn {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "HEAD") return new Response(null, { status: opts?.head ?? 200 });
    if (u === ASSET_URL) return new Response(tarBytes);
    if (u === SUMS_URL) {
      const text = opts?.sumsText ?? `${tarHash}  ${ARTIFACT}\n`;
      return new Response(text);
    }
    return new Response(null, { status: 404 });
  }) as unknown as FetchFn;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ppm-dl-"));
  tarBytes = await buildTarGz(root);
  tarHash = createHash("sha256").update(tarBytes).digest("hex");
});
afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("headCheckAsset", () => {
  it("true on 200", async () => {
    expect(await headCheckAsset(ASSET_URL, makeFetch({ head: 200 }))).toBe(true);
  });
  it("false on 404", async () => {
    expect(await headCheckAsset(ASSET_URL, makeFetch({ head: 404 }))).toBe(false);
  });
});

describe("locatePayloadRoot", () => {
  it("finds binary at depth 0 (flat tar layout)", () => {
    const d = mkdtempSync(join(root, "flat-"));
    writeFileSync(join(d, "ppm"), "x");
    expect(locatePayloadRoot(d, "ppm")).toBe(d);
  });
  it("finds binary at depth 1 (nested zip layout)", () => {
    const d = mkdtempSync(join(root, "nested-"));
    const sub = join(d, "ppm-windows-x64");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "ppm.exe"), "x");
    expect(locatePayloadRoot(d, "ppm.exe")).toBe(sub);
  });
  it("throws when binary absent", () => {
    const d = mkdtempSync(join(root, "empty-"));
    expect(() => locatePayloadRoot(d, "ppm")).toThrow(/incomplete extract/);
  });
});

describe("downloadAndExtract", () => {
  function opts(fetchFn: FetchFn) {
    return {
      assetUrl: ASSET_URL, sha256sumsUrl: SUMS_URL, artifactFilename: ARTIFACT,
      ext: "tar.gz" as const, tmpDir: mkdtempSync(join(root, "tmp-")),
      platform: "linux" as NodeJS.Platform, fetchFn,
    };
  }

  it("downloads, verifies, extracts, returns payload root", async () => {
    const payloadRoot = await downloadAndExtract(opts(makeFetch()));
    expect(existsSync(join(payloadRoot, "ppm"))).toBe(true);
    expect(existsSync(join(payloadRoot, "web"))).toBe(true);
  });

  it("aborts on checksum mismatch (no extract)", async () => {
    const bad = makeFetch({ sumsText: `${"0".repeat(64)}  ${ARTIFACT}\n` });
    await expect(downloadAndExtract(opts(bad))).rejects.toThrow(/checksum mismatch/);
  });

  it("aborts when SHA256SUMS lacks the artifact line", async () => {
    const bad = makeFetch({ sumsText: `${"0".repeat(64)}  some-other-file.tar.gz\n` });
    await expect(downloadAndExtract(opts(bad))).rejects.toThrow(/SHA256SUMS missing/);
  });

  it("aborts on incomplete extract (web/ missing but hash valid)", async () => {
    const noWeb = await buildTarGz(root, false);
    const noWebHash = createHash("sha256").update(noWeb).digest("hex");
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return new Response(null, { status: 200 });
      if (String(url) === ASSET_URL) return new Response(noWeb);
      if (String(url) === SUMS_URL) return new Response(`${noWebHash}  ${ARTIFACT}\n`);
      return new Response(null, { status: 404 });
    }) as unknown as FetchFn;
    await expect(downloadAndExtract(opts(fetchFn))).rejects.toThrow(/incomplete extract: web/);
  });
});
