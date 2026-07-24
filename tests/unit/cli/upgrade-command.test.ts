import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// Mock the upgrade service BEFORE importing the command (dynamic import below).
let checkResult: { available: boolean; current: string; latest: string | null };
let applyResult: { success: boolean; error?: string; newVersion?: string };
let signalResult: { sent: boolean; error?: string };
const calls = { check: 0, apply: 0, signal: 0 };

mock.module("../../../src/services/upgrade.service.ts", () => ({
  checkForUpdate: async () => { calls.check++; return checkResult; },
  applyUpgrade: async () => { calls.apply++; return applyResult; },
  signalSupervisorUpgrade: () => { calls.signal++; return signalResult; },
}));

class ExitError extends Error {
  constructor(public code: number) { super(`exit ${code}`); }
}

const origExit = process.exit;
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  calls.check = 0; calls.apply = 0; calls.signal = 0;
  checkResult = { available: true, current: "1.0.0", latest: "9.9.9" };
  applyResult = { success: true, newVersion: "9.9.9" };
  signalResult = { sent: true };
  process.exit = ((code?: number) => { throw new ExitError(code ?? 0); }) as never;
  console.log = () => {};
  console.error = () => {};
});
afterEach(() => {
  process.exit = origExit;
  console.log = origLog;
  console.error = origErr;
});

async function run(options: { check?: boolean }): Promise<number | "no-exit"> {
  const { upgradeCmd } = await import("../../../src/cli/commands/upgrade.ts");
  try {
    await upgradeCmd(options);
    return "no-exit";
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

describe("upgradeCmd", () => {
  it("(a) binary path no longer early-exits — flows into check→apply→signal", async () => {
    const result = await run({});
    // success path returns without calling process.exit
    expect(result).toBe("no-exit");
    expect(calls.check).toBe(1);
    expect(calls.apply).toBe(1);
    expect(calls.signal).toBe(1);
  });

  it("(b) --check prints status, exits 0, never applies", async () => {
    const code = await run({ check: true });
    expect(code).toBe(0);
    expect(calls.check).toBe(1);
    expect(calls.apply).toBe(0);
  });

  it("(c) already-latest exits 0 without applying", async () => {
    checkResult = { available: false, current: "9.9.9", latest: "9.9.9" };
    const code = await run({});
    expect(code).toBe(0);
    expect(calls.apply).toBe(0);
  });

  it("(d) apply failure exits 1, does not signal restart", async () => {
    applyResult = { success: false, error: "boom" };
    const code = await run({});
    expect(code).toBe(1);
    expect(calls.apply).toBe(1);
    expect(calls.signal).toBe(0);
  });
});
