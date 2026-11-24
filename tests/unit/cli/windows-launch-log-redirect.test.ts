import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * On Windows, `ppm start` and `ppm restart` launch a detached process with
 * PowerShell's `Start-Process -RedirectStandardOutput <file>`. That parameter
 * opens its target with truncate, not append (checked on Windows 11: a file
 * holding two lines held only the child's output afterwards). Pointed at
 * ppm.log it erased every line since the last rotation on each start — a day
 * and a half of log, including the window a chat outage happened in.
 *
 * `ppm start` hands its targets to `startDetachedOnWindows` (`stdoutPath`), the restart worker
 * builds the command inline in a generated script, so the guard reads the source for the
 * redirect targets in whichever form the call site uses.
 */
const SOURCES: { rel: string; target: RegExp }[] = [
  { rel: "src/server/index.ts", target: /stdoutPath: (\w+)/g },
  { rel: "src/cli/commands/restart.ts", target: /-RedirectStandardOutput '["\s+]*\$?\{?(\w+)/g },
];

describe("Windows detached launch never redirects into ppm.log", () => {
  it("the shared helper passes the caller's stdout target to -RedirectStandardOutput", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../..", "src/services/windows-detached-start.ts"), "utf-8");
    expect(src).toContain("-RedirectStandardOutput ${psQuote(opts.stdoutPath)}");
  });

  for (const { rel, target } of SOURCES) {
    it(`${rel} redirects stdout away from ppm.log`, () => {
      const src = readFileSync(resolve(import.meta.dir, "../../..", rel), "utf-8");

      // Every variable handed over as the stdout target must be derived from
      // an .out.log path, never from ppm.log itself.
      const targets = [...src.matchAll(target)].map((m) => m[1]);
      expect(targets.length).toBeGreaterThan(0);
      for (const name of targets) {
        const decl = src.match(new RegExp(`const ${name} = ([^\\n]+)`));
        expect(decl, `declaration of ${name}`).not.toBeNull();
        expect(decl![1]).toContain(".out.log");
      }
    });
  }
});
