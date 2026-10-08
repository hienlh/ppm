/**
 * PPM is routinely reached over plain HTTP on a LAN address, which is not a secure context, and
 * there `crypto.randomUUID` does not exist. A call to it threw on every chat send from such an
 * address for two weeks: the message left the box and nothing was sent, with no error on screen.
 * Browser code takes `randomId()` from `lib/utils.ts`, which falls back when it is missing.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { resolve, sep } from "node:path";

const WEB = resolve(import.meta.dir, "../../../src/web");

describe("browser code runs on a plain-HTTP origin", () => {
  it("calls crypto.randomUUID only behind randomId()'s fallback", () => {
    const offenders = [...new Glob("**/*.{ts,tsx}").scanSync(WEB)]
      .map((file) => file.split(sep).join("/"))
      .filter((file) => file !== "lib/utils.ts" && /\bcrypto\.randomUUID\(/.test(readFileSync(resolve(WEB, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
