/**
 * The SDK puts `mcpServers` on the Claude CLI's command line as `--mcp-config <JSON>`, which any
 * local account can read from the process table. The provider hands them over in a file instead,
 * readable by this user only, and deletes it once the CLI has read it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_CONFIG_FILE_MAX_AGE_MS, moveMcpServersToConfigFile } from "../../../src/providers/claude-agent-sdk-query-options.ts";

let dir: string;
beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), "ppm-mcp-config-")), "claude-mcp-config"); });
afterEach(() => { rmSync(join(dir, ".."), { recursive: true, force: true }); });

const assistant = { type: "http", url: "http://127.0.0.1:8080/api/assistant-mcp", headers: { Authorization: "Bearer secret-token" } };
const notes = { type: "stdio", command: "notes-mcp", args: [], env: { API_KEY: "user-secret" } };

describe("moveMcpServersToConfigFile", () => {
  it("takes every server off the options and names a file holding them instead", () => {
    const { params, release } = moveMcpServersToConfigFile({ prompt: "x", options: { cwd: "/p", mcpServers: { assistant, notes } } }, dir);
    const path = params.options!.extraArgs["mcp-config"];
    expect(params.options!.mcpServers).toBeUndefined();
    expect(JSON.stringify(params)).not.toContain("secret");
    expect(path.startsWith(dir)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mcpServers: { assistant, notes } });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    release();
    expect(existsSync(path)).toBe(false);
    release(); // twice is harmless
  });

  it("keeps the caller's other extra arguments and leaves in-process servers where the SDK serves them", () => {
    const inProcess = { type: "sdk", name: "local", instance: {} };
    const { params, release } = moveMcpServersToConfigFile({ options: { extraArgs: { debug: null }, mcpServers: { inProcess, notes } } }, dir);
    expect(params.options!.extraArgs.debug).toBeNull();
    expect(params.options!.mcpServers).toEqual({ inProcess });
    expect(JSON.parse(readFileSync(params.options!.extraArgs["mcp-config"], "utf8")).mcpServers).toEqual({ notes });
    release();
  });

  it("writes nothing when there is nothing to hand over", () => {
    const input = { options: { cwd: "/p" } };
    expect(moveMcpServersToConfigFile(input, dir).params).toBe(input);
    expect(moveMcpServersToConfigFile({ options: { mcpServers: {} } }, dir).params.options!.extraArgs).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it("sweeps files a server that died before its CLI answered left behind, and only those", () => {
    const first = moveMcpServersToConfigFile({ options: { mcpServers: { notes } } }, dir);
    const stale = join(dir, "left-behind.json");
    writeFileSync(stale, "{}");
    const old = (Date.now() - MCP_CONFIG_FILE_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(stale, old, old);
    const second = moveMcpServersToConfigFile({ options: { mcpServers: { notes } } }, dir);
    const names = readdirSync(dir);
    expect(names).not.toContain("left-behind.json");
    expect(names).toHaveLength(2);
    first.release();
    second.release();
  });
});
