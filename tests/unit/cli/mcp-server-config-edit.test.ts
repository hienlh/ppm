/**
 * The config `ppm mcp add|edit` sends, and the same config as `ppm mcp list` prints it: env and
 * header values never shown, only their names.
 */
import { describe, expect, it } from "bun:test";
import { buildMcpConfig, describeMcpServer, redactMcpConfig, REDACTED } from "../../../src/cli/utils/mcp-server-config-edit.ts";
import { accountRow, findAccount } from "../../../src/cli/utils/account-rows.ts";

describe("buildMcpConfig", () => {
  it("builds a local and a remote server", () => {
    expect(buildMcpConfig(null, { command: "npx", arg: ["-y", "srv"], env: { KEY: "v" } })).toEqual({ command: "npx", args: ["-y", "srv"], env: { KEY: "v" } });
    expect(buildMcpConfig(null, { url: "https://mcp.example/x", header: { Authorization: "Bearer t" } }))
      .toEqual({ type: "http", url: "https://mcp.example/x", headers: { Authorization: "Bearer t" } });
  });

  it("keeps what an edit does not name, and removes what it unsets", () => {
    const existing = { command: "npx", args: ["srv"], env: { A: "1", B: "2" } };
    expect(buildMcpConfig(existing, { env: { C: "3" }, unsetEnv: ["A"] })).toEqual({ command: "npx", args: ["srv"], env: { B: "2", C: "3" } });
    expect(buildMcpConfig(existing, { arg: ["other"] })).toEqual({ command: "npx", args: ["other"], env: { A: "1", B: "2" } });
  });

  it("refuses options that do not fit the server's kind", () => {
    expect(buildMcpConfig(null, {})).toHaveProperty("error");
    expect(buildMcpConfig(null, { command: "a", url: "https://b" })).toHaveProperty("error");
    expect(buildMcpConfig({ type: "http", url: "https://b" }, { env: { K: "v" } })).toHaveProperty("error");
    expect(buildMcpConfig({ command: "a" }, { header: { H: "v" } })).toHaveProperty("error");
    expect(buildMcpConfig({ command: "a" }, { type: "sse" })).toHaveProperty("error");
  });
});

describe("what ppm mcp list shows", () => {
  it("redacts every env and header value and names them", () => {
    const local = { command: "npx", env: { TOKEN: "secret-1" } };
    const remote = { type: "sse" as const, url: "https://m", headers: { Authorization: "Bearer secret-2" } };
    expect(redactMcpConfig(local)).toEqual({ command: "npx", env: { TOKEN: REDACTED } });
    expect(redactMcpConfig(remote)).toEqual({ type: "sse", url: "https://m", headers: { Authorization: REDACTED } });
    expect(describeMcpServer("l", local)).toBe("l  stdio npx  env: TOKEN");
    expect(describeMcpServer("r", remote)).not.toContain("secret-2");
  });
});

describe("what ppm accounts shows", () => {
  it("keeps only the listed fields of an account", () => {
    const row = accountRow("claude", { id: "a1", label: "W", email: "e@x", status: "active", reauthRequired: true, profileData: { secret: 1 } } as never);
    expect(row).toEqual({ id: "a1", provider: "claude", label: "W", email: "e@x", status: "active", note: "sign in again" });
    expect(accountRow("codex", { id: "c1", label: "C", type: "apiKey", home: "/h" } as never)).toEqual({ id: "c1", provider: "codex", label: "C", email: null, status: "active", note: "API key" });
  });

  it("finds an account by a unique start of its id", () => {
    const rows = [accountRow("claude", { id: "abcd-1", label: null, email: null, status: "active" }), accountRow("claude", { id: "abce-2", label: null, email: null, status: "active" })];
    expect(findAccount(rows, "abcd").id).toBe("abcd-1");
    expect(() => findAccount(rows, "abc")).toThrow("No account");
    expect(() => findAccount([...rows, accountRow("claude", { id: "abcd-3", label: null, email: null, status: "active" })], "abcd")).toThrow("more than one");
  });
});
