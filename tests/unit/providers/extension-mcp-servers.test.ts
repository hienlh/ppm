import { describe, expect, it } from "bun:test";
import {
  allowedToolsFor, extensionMcpServers, withSessionTokenMasked,
} from "../../../src/providers/claude-agent-sdk-query-options.ts";
import { extensionToolDecision } from "../../../src/providers/extension-tool-policy.ts";
import { EXTENSION_TOOL_CALL_TIMEOUT_MS } from "../../../src/shared/extension-mcp.ts";

const access = { url: "http://127.0.0.1:8080/api/ext-mcp", token: "tok-ext" };

describe("extensionMcpServers", () => {
  it("is the ppm-ext http server with the session's bearer token in a header", () => {
    expect(extensionMcpServers(access)).toEqual({
      "ppm-ext": {
        type: "http", url: access.url, headers: { Authorization: "Bearer tok-ext" }, timeout: EXTENSION_TOOL_CALL_TIMEOUT_MS + 30_000,
      },
    });
    expect(extensionMcpServers(access)["ppm-ext"]!.url).not.toContain("tok-ext");
  });

  it("adds nothing without access", () => {
    expect(extensionMcpServers(undefined)).toEqual({});
    expect(extensionMcpServers(null)).toEqual({});
  });

  it("outlasts the endpoint's own per-call ceiling", () => {
    expect(extensionMcpServers(access)["ppm-ext"]!.timeout!).toBeGreaterThan(EXTENSION_TOOL_CALL_TIMEOUT_MS);
  });

  it("keeps its token in a spare's fingerprint, so a bound session never adopts a spare", () => {
    const options = { mcpServers: { ...extensionMcpServers(access) } };
    expect(withSessionTokenMasked(options)).toBe(options);
  });

  it("is pre-approved and allowed by the policy for a policy session", () => {
    expect(allowedToolsFor({ isBypass: false, extensionPolicy: true })).toEqual(["mcp__ppm-ext__*"]);
    const policy = { readRoots: ["/r"], writeRoots: ["/r/out"] };
    expect(extensionToolDecision("mcp__ppm-ext__fg_overview", {}, policy, "/r").decision).toBe("allow");
    expect(extensionToolDecision("mcp__ppm-tabs__open_file", {}, policy, "/r").decision).toBe("deny");
  });
});
