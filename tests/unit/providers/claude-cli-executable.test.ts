import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import "../../../tests/test-setup.ts";
import {
  resolveCliExecutablePath,
  needsNodeInterpreter,
} from "../../../src/providers/claude-agent-sdk.ts";

const SAVED = process.env.PPM_CLAUDE_CLI;
beforeEach(() => { delete process.env.PPM_CLAUDE_CLI; });
afterEach(() => { if (SAVED === undefined) delete process.env.PPM_CLAUDE_CLI; else process.env.PPM_CLAUDE_CLI = SAVED; });

describe("resolveCliExecutablePath — source mode (regression lock)", () => {
  it("returns undefined when NOT a compiled binary (source install)", () => {
    // No pathToClaudeCodeExecutable is injected for bun/npm installs.
    expect(resolveCliExecutablePath(undefined, false)).toBeUndefined();
  });
});

describe("resolveCliExecutablePath — compiled mode", () => {
  it("uses an existing override path (config cli_command)", () => {
    // Point the override at a real existing file (this test file itself).
    const real = import.meta.path;
    expect(resolveCliExecutablePath(real, true)).toBe(real);
  });
  it("PPM_CLAUDE_CLI env overrides the config value", () => {
    process.env.PPM_CLAUDE_CLI = import.meta.path;
    expect(resolveCliExecutablePath("/definitely/missing/claude", true)).toBe(import.meta.path);
  });
  it("returns undefined + logs when nothing resolvable", () => {
    let logged = "";
    const orig = console.error;
    console.error = (m?: unknown) => { logged += String(m); };
    try {
      const r = resolveCliExecutablePath("/definitely/missing/claude", true);
      expect(r).toBeUndefined();
      expect(logged).toMatch(/No Claude CLI found/);
    } finally {
      console.error = orig;
    }
  });
});

describe("needsNodeInterpreter", () => {
  it("non-win32 never needs node", () => {
    expect(needsNodeInterpreter("linux", undefined)).toBe(false);
    expect(needsNodeInterpreter("darwin", "/x/cli.js")).toBe(false);
  });
  it("win32 source mode (no cliPath) keeps node — preserves prior behavior", () => {
    expect(needsNodeInterpreter("win32", undefined)).toBe(true);
  });
  it("win32 + .js entry needs node", () => {
    expect(needsNodeInterpreter("win32", "C:\\x\\cli.js")).toBe(true);
    expect(needsNodeInterpreter("win32", "C:\\x\\cli.mjs")).toBe(true);
  });
  it("win32 + native claude.exe does NOT use node", () => {
    expect(needsNodeInterpreter("win32", "C:\\ppm\\cli\\claude.exe")).toBe(false);
  });
  it("win32 + claude.cmd is spawned directly (no node)", () => {
    expect(needsNodeInterpreter("win32", "C:\\ppm\\cli\\claude.cmd")).toBe(false);
  });
});
