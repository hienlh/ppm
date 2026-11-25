/**
 * A pretend Windows for the remote-desktop helper: an in-memory file system, a clock the test
 * moves, and a `run` that answers like `whoami`, `schtasks` and the elevated PowerShell would.
 * Nothing here touches Task Scheduler, UAC or `tscon`.
 */
import type { CommandResult, HelperSystem } from "../../src/services/remote-desktop/win32-helper/helper-system.ts";

export const FAKE_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

export interface FakeWindows extends HelperSystem {
  files: Map<string, string>;
  calls: string[][];
  tasks: Set<string>;
  /** What the next elevated launch exits with; the default (0) also "installs". */
  elevationExit: number;
  /** Called when a `schtasks /run` lands, to write the helper's answer (or not). */
  onTaskRun: (task: string) => void;
  /** The PowerShell text of the last elevated launcher, decoded. */
  lastLauncher: string | null;
}

function decode(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf16le");
}

export function createFakeWindows(): FakeWindows {
  let clock = Date.parse("2026-11-25T16:00:00Z");
  const fake: FakeWindows = {
    platform: "win32",
    files: new Map(),
    calls: [],
    tasks: new Set(),
    elevationExit: 0,
    lastLauncher: null,
    onTaskRun: () => {},
    async run(cmd: string[]): Promise<CommandResult> {
      fake.calls.push(cmd);
      const exe = (cmd[0] ?? "").toLowerCase();
      if (exe.endsWith("whoami.exe")) return { code: 0, stdout: `"host\\pc","${FAKE_SID}"\r\n`, stderr: "" };
      if (exe.endsWith("schtasks.exe")) {
        const name = cmd[3] ?? "";
        if (cmd[1] === "/query") return { code: fake.tasks.has(name) ? 0 : 1, stdout: "", stderr: "" };
        if (cmd[1] === "/run") {
          if (!fake.tasks.has(name)) return { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
          fake.onTaskRun(name);
          return { code: 0, stdout: "SUCCESS", stderr: "" };
        }
      }
      if (exe.endsWith("powershell.exe")) {
        fake.lastLauncher = decode(cmd[cmd.length - 1] ?? "");
        return { code: fake.elevationExit, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command ${cmd.join(" ")}` };
    },
    readText: (path) => fake.files.get(path) ?? null,
    writeText: (path, text) => { fake.files.set(path, text); },
    exists: (path) => fake.files.has(path),
    download: async (url, dest, sha256) => {
      fake.calls.push(["download", url, dest, sha256]);
      fake.files.set(dest, "zip bytes");
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return fake;
}

/** The elevated bootstrap carried inside the launcher, decoded. */
export function bootstrapOf(launcher: string): string {
  const match = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(launcher);
  return match ? decode(match[1]!) : "";
}
