/**
 * End-to-end CLI resolution against a REAL filesystem (the unit test uses a fake
 * fs probe). Meant to run in the Linux Docker container (oven/bun) so the
 * resolver is exercised with real existsSync/statSync semantics on the target OS.
 * No Anthropic API call — asserts WHICH path is resolved (criteria 1, 2, 5).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaudeCliPath } from "../../src/services/claude-cli-resolver.ts";

const realFsExists = (p: string) => {
  try { return existsSync(p) && statSync(p).isFile(); } catch { return false; }
};

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "ppm-cli-e2e-")); });
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

function mkExec(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\necho fake-claude\n");
  chmodSync(path, 0o755);
}

describe("binary CLI resolution — real fs", () => {
  it("A: resolves a system claude found on PATH", () => {
    const bin = join(root, "a-bin");
    mkdirSync(bin, { recursive: true });
    const claude = join(bin, "claude");
    mkExec(claude);
    const r = resolveClaudeCliPath({
      platform: "linux",
      execDir: join(root, "a-noexec"),
      pathEnv: `/nonexistent:${bin}`,
      homeDir: join(root, "a-home"),
      fsExists: realFsExists,
    });
    expect(r).toBe(claude);
  });

  it("B: falls back to shipped <execDir>/cli/claude when no system claude", () => {
    const exec = join(root, "b-exec");
    const shipped = join(exec, "cli", "claude");
    mkExec(shipped);
    const r = resolveClaudeCliPath({
      platform: "linux",
      execDir: exec,
      pathEnv: "",
      homeDir: join(root, "b-empty-home"),
      fsExists: realFsExists,
    });
    expect(r).toBe(shipped);
  });

  it("C: undefined when neither system claude nor shipped CLI exists", () => {
    const r = resolveClaudeCliPath({
      platform: "linux",
      execDir: join(root, "c-none"),
      pathEnv: "",
      homeDir: join(root, "c-none-home"),
      fsExists: realFsExists,
    });
    expect(r).toBeUndefined();
  });

  it("prefers system claude (PATH) over the shipped fallback", () => {
    const bin = join(root, "d-bin");
    const exec = join(root, "d-exec");
    mkExec(join(bin, "claude"));
    mkExec(join(exec, "cli", "claude"));
    const r = resolveClaudeCliPath({
      platform: "linux",
      execDir: exec,
      pathEnv: bin,
      homeDir: join(root, "d-home"),
      fsExists: realFsExists,
    });
    expect(r).toBe(join(bin, "claude"));
  });
});
