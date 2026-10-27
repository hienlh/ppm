import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSessionShell } from "../../../../src/services/chat-session-processes/session-shell-scripts.ts";
import type { SessionShell } from "../../../../src/services/chat-session-processes/session-slice.ts";

// A stand-in systemd-run: records its arguments, then runs what follows `--`, as the real
// `--scope` does in place.
const FAKE_SYSTEMD_RUN = `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "$FAKE_LOG"; done
printf -- '---\\n' >> "$FAKE_LOG"
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; exec "$@"; fi
  shift
done
`;

const SLICE = "app-ppmchat-abcd1234-9788398e17b74ad693c06356ed3f409e.slice";

// `/proc/sys/kernel/random/uuid` names each command's scope.
describe.skipIf(process.platform !== "linux")("chat session shell scripts", () => {
  let dir = "";
  let fake = "";
  let log = "";
  let shell: SessionShell;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ppm-session-shell-"));
    fake = join(dir, "fake-systemd-run");
    writeFileSync(fake, FAKE_SYSTEMD_RUN);
    chmodSync(fake, 0o755);
    log = join(dir, "calls.log");
    shell = installSessionShell(join(dir, "chat-session-shell"), fake);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const calls = (): string[][] => {
    let text = "";
    try { text = readFileSync(log, "utf8"); } catch {}
    rmSync(log, { force: true });
    return text.split("---\n").filter(Boolean).map((call) => call.trimEnd().split("\n"));
  };

  const run = (argv: string[], env: Record<string, string>) => {
    const res = Bun.spawnSync(argv, { env: { PATH: "/usr/bin:/bin", FAKE_LOG: log, ...env } });
    return { code: res.exitCode, out: res.stdout.toString(), err: res.stderr.toString() };
  };

  describe("the shell prefix", () => {
    it("runs the CLI's whole command line in a scope of its own under the session's slice", () => {
      const res = run([shell.prefix, "echo from-the-command; exit 7"], { PPM_CHAT_SLICE: SLICE, SHELL: "/bin/bash" });
      expect(res.out).toBe("from-the-command\n");
      expect(res.code).toBe(7);
      const [call] = calls();
      const unit = call!.find((a) => a.startsWith("--unit="))!;
      expect(unit).toMatch(/^--unit=ppmcmd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(call).toEqual([
        "--user", "--scope", "--quiet", "--collect", `--slice=${SLICE}`, unit, "--description=PPM chat command",
        "--", "/bin/bash", "-c", "echo from-the-command; exit 7",
      ]);
    });

    it("gives every command a scope of its own", () => {
      run([shell.prefix, "true"], { PPM_CHAT_SLICE: SLICE, SHELL: "/bin/bash" });
      run([shell.prefix, "true"], { PPM_CHAT_SLICE: SLICE, SHELL: "/bin/bash" });
      const units = calls().map((call) => call.find((a) => a.startsWith("--unit=")));
      expect(units).toHaveLength(2);
      expect(units[0]).not.toBe(units[1]);
    });

    it("runs the command untouched when the session is not tracked", () => {
      const res = run([shell.prefix, "echo plain; exit 3"], { SHELL: "/bin/bash" });
      expect(res.out).toBe("plain\n");
      expect(res.code).toBe(3);
      expect(calls()).toEqual([]);
    });

    it("uses the shell the CLI was told to, and bash for one it cannot drive", () => {
      const bash = join(dir, "my-shells", "bash");
      mkdirSync(join(dir, "my-shells"), { recursive: true });
      symlinkSync("/bin/bash", bash);
      run([shell.prefix, "true"], { PPM_CHAT_SLICE: SLICE, CLAUDE_CODE_SHELL: bash, SHELL: "/bin/zsh" });
      run([shell.prefix, "true"], { PPM_CHAT_SLICE: SLICE, SHELL: "/usr/bin/fish" });
      const shells = calls().map((call) => call[call.indexOf("--") + 1]);
      expect(shells).toEqual([bash, "/bin/bash"]);
    });
  });

  describe("the systemd-run shim", () => {
    const shim = () => join(shell.pathDir, "systemd-run");

    it("files an agent's own user unit under the session's slice", () => {
      const res = run([shim(), "--user", "--unit=emulator", "--", "sh", "-c", "exit 4"], { PPM_CHAT_SLICE: SLICE });
      expect(res.code).toBe(4);
      expect(calls()).toEqual([[`--slice=${SLICE}`, "--user", "--unit=emulator", "--", "sh", "-c", "exit 4"]]);
    });

    it("leaves a unit alone that names its slice, which is how one outlives the chat", () => {
      run([shim(), "--user", "--slice=app.slice", "--", "true"], { PPM_CHAT_SLICE: SLICE });
      run([shim(), "--user", "--slice", "app.slice", "--", "true"], { PPM_CHAT_SLICE: SLICE });
      run([shim(), "--user", "--slice-inherit", "--", "true"], { PPM_CHAT_SLICE: SLICE });
      expect(calls()).toEqual([
        ["--user", "--slice=app.slice", "--", "true"],
        ["--user", "--slice", "app.slice", "--", "true"],
        ["--user", "--slice-inherit", "--", "true"],
      ]);
    });

    it("reads options only up to `--`, never the command's own", () => {
      run([shim(), "--user", "--", "sh", "-c", "true", "--slice=x"], { PPM_CHAT_SLICE: SLICE });
      run([shim(), "--", "--user", "true"], { PPM_CHAT_SLICE: SLICE });
      expect(calls()).toEqual([
        [`--slice=${SLICE}`, "--user", "--", "sh", "-c", "true", "--slice=x"],
        ["--", "--user", "true"],
      ]);
    });

    it("passes a system unit, and any call outside a tracked chat, straight through", () => {
      run([shim(), "--unit=x", "--", "true"], { PPM_CHAT_SLICE: SLICE });
      run([shim(), "--user", "--", "true"], {});
      expect(calls()).toEqual([["--unit=x", "--", "true"], ["--user", "--", "true"]]);
    });
  });

  it("puts back a script that was changed, and leaves a current one alone", () => {
    writeFileSync(shell.prefix, "#!/bin/sh\nexit 99\n");
    const again = installSessionShell(join(dir, "chat-session-shell"), fake);
    expect(again).toEqual(shell);
    expect(readFileSync(shell.prefix, "utf8")).toContain("PPM chat command");
    const before = statSync(shell.prefix).mtimeMs;
    installSessionShell(join(dir, "chat-session-shell"), fake);
    expect(statSync(shell.prefix).mtimeMs).toBe(before);
    expect(statSync(shell.prefix).mode & 0o777).toBe(0o755);
  });
});
