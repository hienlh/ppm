import { describe, expect, it } from "bun:test";
import {
  isSafeEntry, normalizeTitle, parseManifest, serializeManifest,
} from "../../../src/services/design/design-manifest.ts";

const fallback = { slug: "landing", now: "2026-09-24T00:00:00.000Z" };

describe("design manifest", () => {
  it("reads the known fields and keeps every other field verbatim", () => {
    const raw = JSON.stringify({
      title: "Landing", kind: "slides", entry: "pages/home.html",
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
      tweaks: [{ id: "accent", type: "color", var: "--accent", default: "#ff0000" }], custom: { a: 1 },
    });
    const { manifest, valid } = parseManifest(raw, fallback);
    expect(valid).toBe(true);
    expect(manifest).toMatchObject({ title: "Landing", kind: "slides", entry: "pages/home.html" });
    expect(manifest.extra.tweaks).toEqual([{ id: "accent", type: "color", var: "--accent", default: "#ff0000" }]);
    const round = JSON.parse(serializeManifest(manifest));
    expect(round.custom).toEqual({ a: 1 });
    expect(round.tweaks).toHaveLength(1);
    expect(round.title).toBe("Landing");
  });

  it("falls back field by field, and reports a manifest that is not a JSON object", () => {
    const bad = parseManifest("{not json", fallback);
    expect(bad.valid).toBe(false);
    expect(bad.manifest).toMatchObject({ title: "landing", kind: "page", entry: "index.html", createdAt: fallback.now });
    expect(parseManifest("[1,2]", fallback).valid).toBe(false);
    expect(parseManifest(null, fallback).valid).toBe(false);
    const partial = parseManifest(JSON.stringify({ kind: "poster", entry: "../../etc/passwd.html", createdAt: "nope" }), fallback);
    expect(partial.valid).toBe(true);
    expect(partial.manifest).toMatchObject({ kind: "page", entry: "index.html", createdAt: fallback.now, updatedAt: fallback.now });
  });

  it("only accepts plain relative html entries", () => {
    expect(isSafeEntry("index.html")).toBe(true);
    expect(isSafeEntry("pages/a-b_c.htm")).toBe(true);
    for (const bad of ["../x.html", "/abs.html", "a\\b.html", ".design/x.html", "a/./b.html", "x.js", "c:/x.html", ""]) {
      expect(isSafeEntry(bad)).toBe(false);
    }
  });

  it("normalizes titles", () => {
    expect(normalizeTitle("  Hello\n\tworld  ")).toBe("Hello world");
    expect(normalizeTitle("   ")).toBeNull();
    expect(normalizeTitle(42)).toBeNull();
    expect(normalizeTitle("x".repeat(300))).toHaveLength(120);
  });

  it("cannot be tricked into overriding its own fields through extra", () => {
    const { manifest } = parseManifest(JSON.stringify({ title: "A" }), fallback);
    const text = serializeManifest({ ...manifest, extra: { title: "B", kind: "slides" } });
    expect(JSON.parse(text)).toMatchObject({ title: "A", kind: "page" });
  });
});
