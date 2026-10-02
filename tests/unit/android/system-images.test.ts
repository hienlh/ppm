/**
 * Reading the installed system-image tree off disk.
 *
 * The fixtures are real `source.properties` bodies, trimmed — the parser's whole job is to
 * survive what Google actually ships, including a comma-joined `SystemImage.TagId` and a
 * half-deleted package that left its directories behind.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abiMatchesHost, listSystemImages } from "../../../src/services/android/system-images.ts";

const PLAYSTORE_35 = `Pkg.Desc=Google Play Intel x86_64 Atom System Image
Pkg.Revision=4
AndroidVersion.ApiLevel=35
SystemImage.Abi=x86_64
SystemImage.TagId=google_apis_playstore
SystemImage.TagDisplay=Google Play
SystemImage.GpuSupport=true
`;

const TABLET_35 = `Pkg.Desc=Google Play Tablet Intel x86_64 Atom System Image
AndroidVersion.ApiLevel=35
SystemImage.Abi=x86_64
SystemImage.TagId=google_apis_playstore,tablet
SystemImage.TagDisplay=Google APIs PlayStore,Tablet
`;

const ARM_34 = `Pkg.Desc=Google APIs ARM 64 v8a System Image
AndroidVersion.ApiLevel=34
SystemImage.Abi=arm64-v8a
SystemImage.TagId=google_apis
SystemImage.TagDisplay=Google APIs
`;

/** Build an SDK root holding the given `<api>/<tag>/<abi>` packages. */
function sdkWith(packages: [string, string, string, string | null][]): string {
  const root = mkdtempSync(join(tmpdir(), "ppm-sdk-"));
  for (const [api, tag, abi, props] of packages) {
    const dir = join(root, "system-images", api, tag, abi);
    mkdirSync(dir, { recursive: true });
    if (props !== null) {
      writeFileSync(join(dir, "source.properties"), props);
      writeFileSync(join(dir, "system.img"), "z".repeat(1024));
    }
  }
  return root;
}

describe("listSystemImages", () => {
  test("reads api level, abi and tag out of source.properties", () => {
    const root = sdkWith([["android-35", "google_apis_playstore", "x86_64", PLAYSTORE_35]]);
    const [image] = listSystemImages(root);

    expect(image!.id).toBe("system-images;android-35;google_apis_playstore;x86_64");
    expect(image!.apiLevel).toBe(35);
    expect(image!.abi).toBe("x86_64");
    expect(image!.tagDisplay).toBe("Google Play");
    expect(image!.playStore).toBe(true);
    expect(image!.bytes).toBeGreaterThan(1000);
  });

  test("the id is the package path, so it can be handed straight to --package", () => {
    // The id is built from the *directories*, not from the properties: `SystemImage.TagId` on a
    // tablet image is `google_apis_playstore,tablet`, which names no package.
    const root = sdkWith([["android-35", "google_apis_playstore_tablet", "x86_64", TABLET_35]]);
    const [image] = listSystemImages(root);

    expect(image!.id).toBe("system-images;android-35;google_apis_playstore_tablet;x86_64");
    expect(image!.tag).toBe("google_apis_playstore");
    expect(image!.sysdir).toBe("system-images/android-35/google_apis_playstore_tablet/x86_64/");
  });

  test("a directory with no source.properties is not an installed image", () => {
    const root = sdkWith([
      ["android-35", "google_apis_playstore", "x86_64", PLAYSTORE_35],
      ["android-33", "default", "x86_64", null],
    ]);
    expect(listSystemImages(root).map((i) => i.apiLevel)).toEqual([35]);
  });

  test("newest API first", () => {
    const root = sdkWith([
      ["android-34", "google_apis", "arm64-v8a", ARM_34],
      ["android-35", "google_apis_playstore", "x86_64", PLAYSTORE_35],
    ]);
    expect(listSystemImages(root).map((i) => i.apiLevel)).toEqual([35, 34]);
  });

  test("no SDK, or an SDK with no images, is an empty list rather than a throw", () => {
    expect(listSystemImages(null)).toEqual([]);
    expect(listSystemImages(mkdtempSync(join(tmpdir(), "ppm-sdk-")))).toEqual([]);
  });
});

describe("abiMatchesHost", () => {
  test("an x86_64 host runs the x86 images and not the arm ones", () => {
    expect(abiMatchesHost("x86_64", "x64")).toBe(true);
    expect(abiMatchesHost("x86", "x64")).toBe(true);
    expect(abiMatchesHost("arm64-v8a", "x64")).toBe(false);
  });

  test("an arm64 host is the mirror image", () => {
    expect(abiMatchesHost("arm64-v8a", "arm64")).toBe(true);
    expect(abiMatchesHost("x86_64", "arm64")).toBe(false);
  });

  test("an architecture PPM does not know about is allowed, not blocked", () => {
    // The consequence of a wrong `false` is an image the user owns that PPM refuses to use; the
    // consequence of a wrong `true` is a slow emulator with an explanation already on screen.
    expect(abiMatchesHost("x86_64", "riscv64")).toBe(true);
  });
});
