/** A macOS app's `.icns` as a cached PNG, and the id-to-file boundary in front of it. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleIconPrefix, createDarwinIconConverter, iconCacheName, ICON_PX,
} from "../../../../src/services/system-services/app-icons-darwin.ts";
import { createDarwinAppIconService } from "../../../../src/services/system-services/app-icon-service.ts";
import type { AppIconSource } from "../../../../src/services/system-services/apps-darwin.ts";
import type { Runner } from "../../../../src/services/host-info/spawn-runner.ts";

const BUNDLE = "/Applications/Example.app";
let dir = "";
let icns = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ppm-app-icons-"));
  icns = join(dir, "AppIcon.icns");
  writeFileSync(icns, "icns");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A `sips` that writes the PNG it was asked for, and records each call. */
function fakeSips(opts: { fail?: boolean; delayMs?: number } = {}) {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    if (opts.delayMs) await Bun.sleep(opts.delayMs);
    if (opts.fail) return { stdout: "", stderr: "Error: Unable to render destination image", code: 13, timedOut: false };
    writeFileSync(argv[argv.indexOf("--out") + 1]!, `png of ${argv[argv.length - 3]}`);
    return { stdout: "", stderr: "", code: 0, timedOut: false };
  };
  return { run, calls };
}

const cache = () => join(dir, "cache");

describe("createDarwinIconConverter", () => {
  test("converts once into a file named after the bundle and the icon's mtime", async () => {
    const sips = fakeSips();
    const icons = createDarwinIconConverter(cache(), sips.run);
    utimesSync(icns, 1000, 1000);
    const png = await icons.png(BUNDLE, icns);
    expect(png).toBe(join(cache(), iconCacheName(BUNDLE, 1_000_000)));
    expect(sips.calls[0]!.slice(0, 6)).toEqual(["sips", "-s", "format", "png", "-Z", String(ICON_PX)]);
    expect(await icons.png(BUNDLE, icns)).toBe(png!);
    expect(sips.calls).toHaveLength(1);
    // Only the finished file is left: the conversion wrote to a temporary name.
    expect(readdirSync(cache())).toEqual([iconCacheName(BUNDLE, 1_000_000)]);
  });

  test("a PNG from an earlier run of the server is used as it is", async () => {
    const sips = fakeSips();
    utimesSync(icns, 1000, 1000);
    await createDarwinIconConverter(cache(), sips.run).png(BUNDLE, icns);
    expect(await createDarwinIconConverter(cache(), sips.run).png(BUNDLE, icns)).not.toBeNull();
    expect(sips.calls).toHaveLength(1);
  });

  test("every icon asked for at once shares one conversion", async () => {
    const sips = fakeSips({ delayMs: 20 });
    const icons = createDarwinIconConverter(cache(), sips.run);
    const all = await Promise.all([1, 2, 3, 4].map(() => icons.png(BUNDLE, icns)));
    expect(new Set(all).size).toBe(1);
    expect(sips.calls).toHaveLength(1);
  });

  test("an updated icon gets a new PNG, and the old one is removed", async () => {
    const sips = fakeSips();
    const icons = createDarwinIconConverter(cache(), sips.run);
    utimesSync(icns, 1000, 1000);
    const before = await icons.png(BUNDLE, icns);
    utimesSync(icns, 2000, 2000);
    const after = await icons.png(BUNDLE, icns);
    expect(after).not.toBe(before);
    expect(readdirSync(cache())).toEqual([iconCacheName(BUNDLE, 2_000_000)]);
  });

  test("another bundle's PNGs are left alone", async () => {
    const icons = createDarwinIconConverter(cache(), fakeSips().run);
    await icons.png("/Applications/Other.app", icns);
    await icons.png(BUNDLE, icns);
    expect(readdirSync(cache()).map((f) => f.slice(0, bundleIconPrefix(BUNDLE).length)).sort()).toEqual(
      [bundleIconPrefix("/Applications/Other.app"), bundleIconPrefix(BUNDLE)].sort(),
    );
  });

  test("an icon sips cannot read is none, and is not converted again", async () => {
    const sips = fakeSips({ fail: true });
    const icons = createDarwinIconConverter(cache(), sips.run);
    expect(await icons.png(BUNDLE, icns)).toBeNull();
    expect(await icons.png(BUNDLE, icns)).toBeNull();
    expect(sips.calls).toHaveLength(1);
    expect(readdirSync(cache())).toEqual([]);
  });

  test("a missing icon file is none, without running sips", async () => {
    const sips = fakeSips();
    expect(await createDarwinIconConverter(cache(), sips.run).png(BUNDLE, join(dir, "gone.icns"))).toBeNull();
    expect(sips.calls).toEqual([]);
  });

  test("a cache directory that cannot be created is no icon, not an exception", async () => {
    const blocked = join(dir, "file");
    writeFileSync(blocked, "");
    expect(await createDarwinIconConverter(join(blocked, "cache"), fakeSips().run).png(BUNDLE, icns)).toBeNull();
  });
});

describe("createDarwinAppIconService", () => {
  const source: AppIconSource = { bundle: BUNDLE, iconPath: "/Applications/Example.app/Contents/Resources/AppIcon.icns" };

  function service() {
    const asked: string[] = [];
    const converted: [string, string][] = [];
    const svc = createDarwinAppIconService(
      { iconSource: (id) => { asked.push(id); return id === "com.example.app" ? source : null; } },
      { png: async (bundle, iconPath) => { converted.push([bundle, iconPath]); return "/cache/example.png"; } },
    );
    return { svc, asked, converted };
  }

  test("a listed app's icon is converted from its own bundle", async () => {
    const { svc, converted } = service();
    expect(await svc.path("com.example.app")).toBe("/cache/example.png");
    expect(converted).toEqual([[BUNDLE, source.iconPath]]);
  });

  test("an id the last tick did not list has no icon", async () => {
    const { svc, converted } = service();
    expect(await svc.path("com.example.other")).toBeNull();
    expect(converted).toEqual([]);
  });

  test("something shaped like a path is refused before anything is looked up", async () => {
    const { svc, asked } = service();
    for (const id of ["", "..", "../../etc/passwd", "a/b"]) expect(await svc.path(id)).toBeNull();
    expect(asked).toEqual([]);
  });
});

const CALCULATOR_ICON = "/System/Applications/Calculator.app/Contents/Resources/AppIcon.icns";

describe.if(process.platform === "darwin" && existsSync(CALCULATOR_ICON))("real sips on this Mac", () => {
  test("Calculator's icon becomes a 64 px PNG", async () => {
    const png = await createDarwinIconConverter(cache()).png("/System/Applications/Calculator.app", CALCULATOR_ICON);
    const bytes = readFileSync(png!);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR width and height, big-endian, right after the signature and chunk header.
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([ICON_PX, ICON_PX]);
  });
});
