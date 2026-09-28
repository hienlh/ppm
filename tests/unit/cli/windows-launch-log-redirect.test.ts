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
 * Both call sites build the command inline (one inside a generated worker
 * script), so the guard reads the source for the redirect targets.
 */
const SOURCES = [
  "src/server/index.ts",
  "src/cli/commands/restart.ts",
];

describe("Windows detached launch never redirects into ppm.log", () => {
  for (const rel of SOURCES) {
    it(`${rel} redirects stdout away from ppm.log`, () => {
      const src = readFileSync(resolve(import.meta.dir, "../../..", rel), "utf-8");
      expect(src).toContain("-RedirectStandardOutput");

      // Every variable handed to -RedirectStandardOutput must be derived from
      // an .out.log path, never from ppm.log itself.
      const targets = [...src.matchAll(/-RedirectStandardOutput '["\s+]*\$?\{?(\w+)/g)].map((m) => m[1]);
      expect(targets.length).toBeGreaterThan(0);
      for (const name of targets) {
        const decl = src.match(new RegExp(`const ${name} = ([^\\n]+)`));
        expect(decl, `declaration of ${name}`).not.toBeNull();
        expect(decl![1]).toContain(".out.log");
      }
    });
  }
});
