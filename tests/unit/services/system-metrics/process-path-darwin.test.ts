/** A process's executable as the kernel knows it: `proc_pidpath` over FFI. */
import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { darwinProcessPath } from "../../../../src/services/system-metrics/process-path-darwin.ts";

describe.if(process.platform === "darwin")("darwinProcessPath on this Mac", () => {
  test("this process runs bun", () => {
    expect(darwinProcessPath(process.pid)).toBe(realpathSync(process.execPath));
  });

  test("another user's process is answered too", () => {
    expect(darwinProcessPath(1)).toBe("/sbin/launchd");
  });

  test("a pid that does not exist has no path", () => {
    expect(darwinProcessPath(2_000_000)).toBeUndefined();
  });
});

describe.if(process.platform !== "darwin")("darwinProcessPath elsewhere", () => {
  test("answers nothing rather than throwing", () => {
    expect(darwinProcessPath(process.pid)).toBeUndefined();
  });
});
