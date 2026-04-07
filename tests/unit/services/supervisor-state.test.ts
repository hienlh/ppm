import { describe, test, expect, afterEach } from "bun:test";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

describe("supervisor command file protocol", () => {
  const tmpDir = resolve(tmpdir(), `ppm-test-${Date.now()}`);
  const cmdFile = resolve(tmpDir, ".supervisor-cmd");

  afterEach(() => {
    try { unlinkSync(cmdFile); } catch {}
  });

  test("soft_stop command file is valid JSON", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cmd = { action: "soft_stop" };
    writeFileSync(cmdFile, JSON.stringify(cmd));

    const read = JSON.parse(readFileSync(cmdFile, "utf-8"));
    expect(read.action).toBe("soft_stop");
  });

  test("resume command file is valid JSON", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cmd = { action: "resume" };
    writeFileSync(cmdFile, JSON.stringify(cmd));

    const read = JSON.parse(readFileSync(cmdFile, "utf-8"));
    expect(read.action).toBe("resume");
  });
});

describe("supervisor-state module", () => {
  test("getState returns initial state 'running'", async () => {
    // Import fresh — state is module-level
    const { getState } = await import("../../../src/services/supervisor-state.ts");
    expect(getState()).toBe("running");
  });

  test("setState changes state", async () => {
    const { getState, setState } = await import("../../../src/services/supervisor-state.ts");
    setState("stopped");
    expect(getState()).toBe("stopped");
    // Reset for other tests
    setState("running");
  });

  test("triggerResume resolves waitForResume", async () => {
    const { waitForResume, triggerResume } = await import("../../../src/services/supervisor-state.ts");

    let resolved = false;
    const promise = waitForResume().then(() => { resolved = true; });
    expect(resolved).toBe(false);

    triggerResume();
    await promise;
    expect(resolved).toBe(true);
  });

  test("readAndDeleteCmd returns null when no file exists", async () => {
    const { readAndDeleteCmd } = await import("../../../src/services/supervisor-state.ts");
    const result = readAndDeleteCmd();
    // CMD_FILE in the module uses the real ~/.ppm path; if no cmd file exists, returns null
    expect(result).toBeNull();
  });
});
