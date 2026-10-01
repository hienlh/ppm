/**
 * Binary plists, checked against CoreFoundation's own writer: each `.bplist`
 * fixture has an XML twin that `plutil -convert xml1` made from it (Safari's real
 * Info.plist) or it from (the synthetic sample), and both must parse to the same
 * values. The hostile cases are hand-built, since no real writer produces them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isBinaryPlist, parsePlistBinary, parsePlistBytes,
} from "../../../../src/services/system-metrics/plist-binary.ts";
import { parsePlistXml, type PlistDict, type PlistValue } from "../../../../src/services/system-metrics/plist-xml.ts";
import { darwinFixture } from "./fixtures/darwin-fixture.ts";

const bytesOf = (name: string) => new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", "darwin", name)));

const be = (n: number, width: number) => Array.from({ length: width }, (_, i) => Math.floor(n / 256 ** (width - 1 - i)) % 256);

/** A bplist00 file from raw object encodings, with 1-byte offsets and references. */
function bplist(objects: number[][], top = 0, trailer: { offsetSize?: number; refSize?: number; tableAt?: number } = {}): Uint8Array {
  const { offsetSize = 1, refSize = 1 } = trailer;
  const magic = [...Buffer.from("bplist00")];
  const body: number[] = [];
  const offsets: number[] = [];
  for (const o of objects) {
    offsets.push(magic.length + body.length);
    body.push(...o);
  }
  const tableAt = trailer.tableAt ?? magic.length + body.length;
  return new Uint8Array([
    ...magic, ...body, ...offsets.flatMap((o) => be(o, offsetSize)),
    0, 0, 0, 0, 0, 0, offsetSize, refSize, ...be(objects.length, 8), ...be(top, 8), ...be(tableAt, 8),
  ]);
}

describe("parsePlistBinary against CoreFoundation's writer", () => {
  test("Safari's real Info.plist reads exactly as its XML conversion does", () => {
    const binary = parsePlistBinary(bytesOf("info-plist-safari.bplist"));
    expect(binary).toEqual(parsePlistXml(darwinFixture("info-plist-safari.xml"))!);
    // 418 objects: past 255, so every reference in the file is two bytes wide.
    expect((binary as PlistDict).CFBundleIdentifier).toBe("com.apple.Safari");
  });

  test("the sample reads as its XML source does, every value type included", () => {
    const binary = parsePlistBinary(bytesOf("info-plist-sample.bplist")) as PlistDict;
    expect(binary).toEqual(parsePlistXml(darwinFixture("info-plist-sample.xml")) as PlistDict);
    expect(binary.ExampleUnicode).toBe("Ứng dụng mẫu 日本 🎉");
    // The last is u64 max, stored in 16 bytes, which a JS number rounds to 2^64.
    expect(binary.ExampleIntegers).toEqual([0, 200, 40_000, 3_000_000_000, -5, 9_007_199_254_740_991, 2 ** 64]);
    expect(binary.ExampleDate).toBe("2026-09-30T12:00:00Z");
    expect(binary.ExampleData).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(binary.ExampleReal).toBe(3.25);
    expect([binary.LSUIElement, binary.NSHighResolutionCapable]).toEqual([true, false]);
    // Two keys, one string object: plutil stores a repeated value once.
    expect([binary.CFBundleDisplayName, binary.CFBundleExecutable]).toEqual(["Example App", "Example App"]);
  });

  test("a dictionary has no prototype, so a key cannot reach Object's", () => {
    const v = parsePlistBinary(bplist([[0xd1, 1, 2], [0x59, ...Buffer.from("__proto__")], [0x09]]));
    expect(Object.getPrototypeOf(v)).toBeNull();
    expect((v as PlistDict)["__proto__" as string]).toBe(true);
  });

  test("a null object is skipped where it appears", () => {
    expect(parsePlistBinary(bplist([[0xa2, 1, 2], [0x00], [0x09]]))).toEqual([true]);
  });
});

describe("parsePlistBytes", () => {
  test("reads either format by its magic", () => {
    expect(isBinaryPlist(bytesOf("info-plist-sample.bplist"))).toBe(true);
    expect(isBinaryPlist(bytesOf("info-plist-sample.xml"))).toBe(false);
    expect(parsePlistBytes(bytesOf("info-plist-sample.xml"))).toEqual(parsePlistBytes(bytesOf("info-plist-sample.bplist"))!);
  });
});

describe("parsePlistBinary refuses what no writer produces", () => {
  test("a reference cycle, direct or through another object", () => {
    expect(parsePlistBinary(bplist([[0xa1, 0]]))).toBeUndefined();
    expect(parsePlistBinary(bplist([[0xa1, 1], [0xa1, 0]]))).toBeUndefined();
  });

  test("a fan-out that would unfold into 2^40 values reads each object once", () => {
    const objects = Array.from({ length: 40 }, (_, i) => [0xa2, i + 1, i + 1]);
    objects.push([0x09]);
    const started = performance.now();
    const root = parsePlistBinary(bplist(objects)) as PlistValue[];
    expect(performance.now() - started).toBeLessThan(50);
    expect(root[0]).toBe(root[1]!);
  });

  test("nesting past any Info.plist's depth", () => {
    const objects = Array.from({ length: 100 }, (_, i) => [0xa1, i + 1]);
    objects.push([0x09]);
    expect(parsePlistBinary(bplist(objects))).toBeUndefined();
  });

  test("a length or offset that runs past the file", () => {
    // A string claiming 255 bytes with 3 present.
    expect(parsePlistBinary(bplist([[0x5f, 0x10, 0xff, 0x61, 0x62, 0x63]]))).toBeUndefined();
    // An array whose references run into the offset table.
    expect(parsePlistBinary(bplist([[0xa9, 0]]))).toBeUndefined();
    // An offset table pointing into the trailer.
    expect(parsePlistBinary(bplist([[0x09]], 0, { tableAt: 200 }))).toBeUndefined();
  });

  test("a trailer that does not describe the file", () => {
    expect(parsePlistBinary(bplist([[0x09]], 1))).toBeUndefined();
    expect(parsePlistBinary(bplist([[0x09]], 0, { offsetSize: 3 }))).toBeUndefined();
    expect(parsePlistBinary(bplist([[0x09]], 0, { refSize: 0 }))).toBeUndefined();
  });

  test("a dictionary key that is not a string, and an unknown marker", () => {
    expect(parsePlistBinary(bplist([[0xd1, 1, 2], [0x10, 1], [0x09]]))).toBeUndefined();
    expect(parsePlistBinary(bplist([[0x70]]))).toBeUndefined();
  });

  test("a truncated file, and anything that is not a binary plist", () => {
    const whole = bytesOf("info-plist-sample.bplist");
    for (const cut of [8, 39, whole.byteLength - 1]) expect(parsePlistBinary(whole.slice(0, cut))).toBeUndefined();
    expect(parsePlistBinary(bytesOf("info-plist-sample.xml"))).toBeUndefined();
    expect(parsePlistBinary(new Uint8Array(0))).toBeUndefined();
  });
});
