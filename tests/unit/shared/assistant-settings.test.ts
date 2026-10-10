import { describe, expect, it } from "bun:test";
import {
  ASSISTANT_INSTRUCTIONS_MAX_CHARS, assistantMcpNameError, maskAssistantSettings, readAssistantSettings,
} from "../../../src/shared/assistant-settings.ts";

const stdio = (name: string, extra: Record<string, unknown> = {}) => ({ name, transport: "stdio", command: "npx", args: ["x"], env: {}, ...extra });

describe("assistantMcpNameError", () => {
  it("accepts names both providers take", () => {
    for (const name of ["github", "my-server", "db_tools", "A1"]) expect(assistantMcpNameError(name)).toBeNull();
  });

  it("refuses the Assistant's own server under either provider's spelling, in any case", () => {
    for (const name of ["ppm-assistant", "ppm_assistant", "PPM-Assistant"]) expect(assistantMcpNameError(name)).toContain("own tool server");
  });

  it("refuses the Assistant's own name with `_` or `-` added, whose Claude tool names would begin with its prefix", () => {
    for (const name of ["ppm-assistant_", "ppm-assistant-", "ppm_assistant-", "PPM-Assistant_-"]) {
      expect(assistantMcpNameError(name)).toContain("own tool server");
    }
    for (const name of ["ppm-assistant2", "ppm-assistant-notes", "my-ppm-assistant"]) expect(assistantMcpNameError(name)).toBeNull();
  });

  it("refuses unsafe characters, a double underscore, an empty or overlong name", () => {
    for (const name of ["", "-x", "a.b", "a b", "a/b", "x__y", "a".repeat(49)]) expect(assistantMcpNameError(name)).not.toBeNull();
  });
});

describe("readAssistantSettings", () => {
  it("normalises valid settings", () => {
    const { value, errors } = readAssistantSettings({
      default_provider: "codex",
      providers: { claude: { model: " claude-opus-5 ", effort: "xhigh" }, codex: { model: "" } },
      instructions: "  Be brief.  ",
      mcp_servers: [stdio("github", { id: "abc", env: { GH_TOKEN: "t" } }), { name: "docs", transport: "http", url: "https://d.example/mcp", headers: { "X-Key": "k" } }],
    });
    expect(errors).toEqual([]);
    expect(value.default_provider).toBe("codex");
    expect(value.providers).toEqual({ claude: { model: "claude-opus-5", effort: "xhigh" } });
    expect(value.instructions).toBe("Be brief.");
    expect(value.mcp_servers[0]).toEqual({ id: "abc", name: "github", enabled: true, transport: "stdio", command: "npx", args: ["x"], env: { GH_TOKEN: "t" } });
    expect(value.mcp_servers[1]).toMatchObject({ id: "", transport: "http", headers: { "X-Key": "k" } });
  });

  it("refuses duplicate (case- and dash-folded) and reserved names", () => {
    expect(readAssistantSettings({ mcp_servers: [stdio("my-db"), stdio("My_DB")] }).errors).toEqual(['Two MCP servers are named "My_DB"']);
    expect(readAssistantSettings({ mcp_servers: [stdio("ppm_assistant")] }).errors[0]).toContain("own tool server");
  });

  it("refuses a bad transport, URL, effort, variable or header", () => {
    const errors = (raw: unknown) => readAssistantSettings(raw).errors;
    expect(errors({ mcp_servers: [{ name: "x", transport: "sse", url: "https://x" }] })[0]).toContain("transport must be stdio or http");
    expect(errors({ mcp_servers: [{ name: "x", transport: "http", url: "file:///etc/passwd" }] })[0]).toContain("http:// or https://");
    expect(errors({ mcp_servers: [stdio("x", { command: " " })] })[0]).toContain("command is required");
    expect(errors({ mcp_servers: [stdio("x", { env: { "BAD-NAME": "v" } })] })[0]).toContain("not a valid variable name");
    expect(errors({ mcp_servers: [{ name: "x", transport: "http", url: "https://x", headers: { "X-A": "a\r\nInjected: 1" } }] })[0]).toContain("line break");
    expect(errors({ providers: { claude: { effort: "extra" } } })[0]).toContain("effort must be one of");
    expect(errors({ instructions: "x".repeat(ASSISTANT_INSTRUCTIONS_MAX_CHARS + 1) })[0]).toContain("at most");
    expect(errors("nope")).toEqual(["settings must be an object"]);
  });
});

describe("maskAssistantSettings", () => {
  it("blanks every env and header value and keeps the keys", () => {
    const { value } = readAssistantSettings({
      mcp_servers: [stdio("a", { env: { TOKEN: "s1" } }), { name: "b", transport: "http", url: "https://b", headers: { Authorization: "Bearer s2" } }],
    });
    const masked = maskAssistantSettings(value);
    expect(JSON.stringify(masked)).not.toContain("s1");
    expect(JSON.stringify(masked)).not.toContain("s2");
    expect(masked.mcp_servers[0]).toMatchObject({ env: { TOKEN: "" } });
    expect(masked.mcp_servers[1]).toMatchObject({ headers: { Authorization: "" } });
    // The stored settings are untouched.
    expect(value.mcp_servers[0]).toMatchObject({ env: { TOKEN: "s1" } });
  });
});
