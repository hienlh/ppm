import { describe, expect, it } from "bun:test";
import { splitSourceLocation, formatSourceLocation } from "../../../src/web/lib/source-location";

describe("splitSourceLocation", () => {
  it.each([
    ["src/app.ts:120", "src/app.ts", { start: 120 }],
    ["src/app.ts:120:5", "src/app.ts", { start: 120 }],
    ["src/app.ts:120-140", "src/app.ts", { start: 120, end: 140 }],
    ["src/app.ts#L120", "src/app.ts", { start: 120 }],
    ["src/app.ts#L120-L140", "src/app.ts", { start: 120, end: 140 }],
    ["src/app.ts#L120-140", "src/app.ts", { start: 120, end: 140 }],
    // The drive letter is a colon too, and the lazy head is what keeps it on the path.
    ["D:/Projects/nxsys/src/PaymentForm.tsx:160", "D:/Projects/nxsys/src/PaymentForm.tsx", { start: 160 }],
    ["C:/repo/app.ts", "C:/repo/app.ts", undefined],
  ])("splits %s", (text, path, line) => {
    expect(splitSourceLocation(text as string)).toEqual({ path, line });
  });

  it.each(["src/app.ts", "", "README", "app:tsx"])("leaves %p whole when nothing names a line", (text) => {
    expect(splitSourceLocation(text)).toEqual({ path: text });
  });

  it.each(["app.ts:0", "app.ts#L0", "app.ts:10-9", "app.ts:9007199254740992", "app.ts#L1-L9007199254740992"])(
    "rejects %p rather than silently opening line 1",
    (text) => {
      expect(splitSourceLocation(text)).toBeNull();
    },
  );
});

describe("formatSourceLocation", () => {
  it.each([
    ["src/app.ts", undefined, "src/app.ts"],
    ["src/app.ts", { start: 120 }, "src/app.ts:120"],
    ["src/app.ts", { start: 120, end: 140 }, "src/app.ts:120-140"],
  ])("renders %p + %p", (path, line, expected) => {
    expect(formatSourceLocation(path as string, line as { start: number; end?: number } | undefined)).toBe(expected);
  });

  it("round-trips through the parser", () => {
    for (const line of [undefined, { start: 7 }, { start: 7, end: 9 }]) {
      const text = formatSourceLocation("D:/repo/app.ts", line);
      expect(splitSourceLocation(text)).toEqual({ path: "D:/repo/app.ts", line });
    }
  });
});
