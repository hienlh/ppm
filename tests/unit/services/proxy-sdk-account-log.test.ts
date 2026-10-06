/**
 * The proxy writes one line per forwarded request, and bare `console.log` lands in ppm.log at
 * INFO, which the public `/api/logs/recent` serves. The account in that line must be its id: the
 * email is the person's address.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as realSdk from "@anthropic-ai/claude-agent-sdk";

const real = { ...realSdk };
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...real,
  // An empty turn, so nothing is spawned.
  query: () => ({ async *[Symbol.asyncIterator]() {} }),
}));

const { forwardViaSdk } = await import("../../../src/services/proxy-sdk-bridge.ts");
const { forwardOpenAiViaSdk } = await import("../../../src/services/proxy-openai-bridge.ts");

const account = { id: "acc-7", email: "someone@example.com", accessToken: "token" };
const body = { model: "sonnet", stream: false, max_tokens: 16, messages: [{ role: "user", content: "hi" }] };

describe("the proxy's per-request log line", () => {
  let log: ReturnType<typeof spyOn<Console, "log">>;
  afterEach(() => log.mockRestore());

  function linesFrom(): string[] {
    return log.mock.calls.map((args) => args.map(String).join(" "));
  }

  it("names the account by id on the Messages API path", async () => {
    log = spyOn(console, "log").mockImplementation(() => {});
    await forwardViaSdk(body, account);
    const line = linesFrom().find((l) => l.startsWith("[proxy-sdk]"));
    expect(line).toContain("acc-7");
    expect(line).not.toContain("someone@example.com");
  });

  it("names the account by id on the OpenAI path", async () => {
    log = spyOn(console, "log").mockImplementation(() => {});
    await forwardOpenAiViaSdk(body, account);
    const line = linesFrom().find((l) => l.startsWith("[proxy-openai]"));
    expect(line).toContain("acc-7");
    expect(line).not.toContain("someone@example.com");
  });
});
