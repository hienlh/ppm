/**
 * Picking which precompressed copy of an asset to send.
 *
 * The failure mode to guard is not "no compression" — that is merely slow. It
 * is sending a body in an encoding the client did not accept, which is not a
 * slow page but a broken one, and `q=0` is the case that looks like acceptance
 * to a naive substring check.
 */
import { describe, it, expect } from "bun:test";
import { acceptedEncodings, chooseVariant } from "../../../src/server/routes/static-encoding.ts";

/** Pretends the build wrote both variants for everything. */
const bothExist = (path: string) => path.endsWith(".br") || path.endsWith(".gz");

describe("acceptedEncodings", () => {
  it("prefers brotli when both are offered", () => {
    // PPM's preference, not the client's: brotli is ~25% smaller on this bundle.
    expect(acceptedEncodings("gzip, deflate, br")).toEqual(["br", "gzip"]);
  });

  it("offers only gzip when that is all the client takes", () => {
    expect(acceptedEncodings("gzip, deflate")).toEqual(["gzip"]);
  });

  it("is empty with no header", () => {
    expect(acceptedEncodings(undefined)).toEqual([]);
    expect(acceptedEncodings("")).toEqual([]);
  });

  it("honours q=0 as a refusal", () => {
    // A client that sends `gzip;q=0` and receives gzip cannot read the body.
    expect(acceptedEncodings("gzip;q=0, br")).toEqual(["br"]);
    expect(acceptedEncodings("br;q=0, gzip")).toEqual(["gzip"]);
    expect(acceptedEncodings("gzip;q=0, br;q=0")).toEqual([]);
  });

  it("keeps an encoding with a non-zero q", () => {
    expect(acceptedEncodings("br;q=1.0, gzip;q=0.5")).toEqual(["br", "gzip"]);
    expect(acceptedEncodings("gzip;q=0.001")).toEqual(["gzip"]);
  });

  it("reads a wildcard as any encoding", () => {
    expect(acceptedEncodings("*")).toEqual(["br", "gzip"]);
  });

  it("lets a named refusal beat the wildcard", () => {
    expect(acceptedEncodings("*, br;q=0")).toEqual(["gzip"]);
  });

  it("ignores case and whitespace", () => {
    expect(acceptedEncodings("  BR ,  GZIP  ")).toEqual(["br", "gzip"]);
  });

  it("ignores encodings PPM does not produce", () => {
    expect(acceptedEncodings("zstd, deflate, compress")).toEqual([]);
  });
});

describe("chooseVariant", () => {
  it("sends brotli when the client takes it", () => {
    expect(chooseVariant("/w/app.js", "br, gzip", bothExist)).toEqual({
      path: "/w/app.js.br",
      encoding: "br",
    });
  });

  it("falls back to gzip", () => {
    expect(chooseVariant("/w/app.js", "gzip", bothExist)).toEqual({
      path: "/w/app.js.gz",
      encoding: "gzip",
    });
  });

  it("sends the original when the client accepts nothing", () => {
    expect(chooseVariant("/w/app.js", undefined, bothExist)).toEqual({
      path: "/w/app.js",
      encoding: null,
    });
  });

  it("sends the original when the build skipped compression", () => {
    // A build without the precompress step has to keep working, just heavier.
    expect(chooseVariant("/w/app.js", "br, gzip", () => false)).toEqual({
      path: "/w/app.js",
      encoding: null,
    });
  });

  it("skips brotli and takes gzip when only the gzip file was written", () => {
    // Which is what happens when brotli did not beat the original.
    const onlyGzip = (path: string) => path.endsWith(".gz");

    expect(chooseVariant("/w/app.js", "br, gzip", onlyGzip)).toEqual({
      path: "/w/app.js.gz",
      encoding: "gzip",
    });
  });

  it("does not encode a request for the variant itself", () => {
    // Otherwise `/assets/app.js.br` would look for `app.js.br.br`, and a client
    // fetching a variant directly would be told it was encoded twice.
    expect(chooseVariant("/w/app.js.br", "br", bothExist)).toEqual({
      path: "/w/app.js.br",
      encoding: null,
    });
    expect(chooseVariant("/w/app.js.gz", "gzip", bothExist)).toEqual({
      path: "/w/app.js.gz",
      encoding: null,
    });
  });
});
