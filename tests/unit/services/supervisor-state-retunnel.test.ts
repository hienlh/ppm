import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { writeCmd, requestTunnelReload, CMD_FILE, STATUS_FILE } from "../../../src/services/supervisor-state.ts";

// Guard: if requestTunnelReload's SIGUSR2 lands on this test process (self-PID
// case below), the default disposition would terminate it — a no-op handler
// keeps the test process alive so we can assert on the return value instead.
process.on("SIGUSR2", () => {});

describe("supervisor-state — retunnel", () => {
  let ppmHome: string;

  beforeEach(() => {
    ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-retunnel-"));
    process.env.PPM_HOME = ppmHome;
    _resetPpmDir();
  });

  afterEach(() => {
    delete process.env.PPM_HOME;
    _resetPpmDir();
    rmSync(ppmHome, { recursive: true, force: true });
  });

  describe("writeCmd no-clobber", () => {
    test("writes when no command file exists", () => {
      expect(writeCmd("retunnel")).toBe(true);
      expect(JSON.parse(readFileSync(CMD_FILE(), "utf-8")).action).toBe("retunnel");
    });

    test("writes when the file holds the same action already", () => {
      writeFileSync(CMD_FILE(), JSON.stringify({ action: "retunnel" }));
      expect(writeCmd("retunnel")).toBe(true);
    });

    test("refuses to clobber a different unclaimed action", () => {
      writeFileSync(CMD_FILE(), JSON.stringify({ action: "restart" }));
      expect(writeCmd("retunnel")).toBe(false);
      expect(JSON.parse(readFileSync(CMD_FILE(), "utf-8")).action).toBe("restart");
    });

    test("a lifecycle action overwrites a pending retunnel", () => {
      writeFileSync(CMD_FILE(), JSON.stringify({ action: "retunnel" }));
      for (const action of ["resume", "soft_stop", "restart", "upgrade"] as const) {
        writeFileSync(CMD_FILE(), JSON.stringify({ action: "retunnel" }));
        expect(writeCmd(action)).toBe(true);
        expect(JSON.parse(readFileSync(CMD_FILE(), "utf-8")).action).toBe(action);
      }
    });

    test("retunnel still yields to a pending lifecycle action", () => {
      for (const action of ["resume", "soft_stop", "restart", "upgrade"] as const) {
        writeFileSync(CMD_FILE(), JSON.stringify({ action }));
        expect(writeCmd("retunnel")).toBe(false);
        expect(JSON.parse(readFileSync(CMD_FILE(), "utf-8")).action).toBe(action);
      }
    });

    test("two different lifecycle actions still refuse to clobber each other", () => {
      writeFileSync(CMD_FILE(), JSON.stringify({ action: "restart" }));
      expect(writeCmd("resume")).toBe(false);
      expect(JSON.parse(readFileSync(CMD_FILE(), "utf-8")).action).toBe("restart");
    });
  });

  describe("requestTunnelReload", () => {
    test("returns 'no-supervisor' when status.json has no supervisorPid", () => {
      writeFileSync(STATUS_FILE(), JSON.stringify({}));
      expect(requestTunnelReload()).toBe("no-supervisor");
    });

    test("returns 'no-supervisor' when the recorded PID is dead", () => {
      // PID unlikely to be alive; process.kill(pid,0) throws ESRCH on POSIX.
      writeFileSync(STATUS_FILE(), JSON.stringify({ supervisorPid: 999999 }));
      const result = requestTunnelReload();
      expect(["no-supervisor", "sent", "busy"]).toContain(result); // win32 skips the liveness probe
      if (process.platform !== "win32") expect(result).toBe("no-supervisor");
    });

    test("returns 'busy' when a different unclaimed command is already pending", () => {
      writeFileSync(STATUS_FILE(), JSON.stringify({ supervisorPid: process.pid }));
      writeFileSync(CMD_FILE(), JSON.stringify({ action: "restart" }));
      expect(requestTunnelReload()).toBe("busy");
      // Must not have clobbered the pending restart.
      expect(JSON.parse(readFileSync(CMD_FILE(), "utf-8")).action).toBe("restart");
    });

    test("returns 'sent' and writes the retunnel command when the supervisor is alive", () => {
      writeFileSync(STATUS_FILE(), JSON.stringify({ supervisorPid: process.pid }));
      expect(requestTunnelReload()).toBe("sent");
      expect(JSON.parse(readFileSync(CMD_FILE(), "utf-8")).action).toBe("retunnel");
    });
  });
});
