/**
 * Proxy URL shapes, shared by the Connection Info card and the Test dialog.
 *
 * These existed in both places and only the card knew about provider prefixes,
 * so selecting a provider showed one set of URLs while Test called another and
 * the reply came back from the wrong engine. One helper, pinned here.
 */
import { describe, it, expect } from "bun:test";
import { proxyPrefix, proxyEndpoints } from "../../../src/web/lib/proxy-endpoints.ts";

const ROOT = "https://pc.example.tech";

describe("proxy endpoints", () => {
  it("keeps the default path unscoped", () => {
    expect(proxyPrefix(ROOT)).toBe(`${ROOT}/proxy`);
    expect(proxyPrefix(ROOT, "")).toBe(`${ROOT}/proxy`);
  });

  it("inserts the provider between /proxy and /v1", () => {
    // The position matters: each SDK appends its own vendor path after the base,
    // so the provider has to sit in front of /v1 for both dialects at once.
    expect(proxyPrefix(ROOT, "codex")).toBe(`${ROOT}/proxy/codex`);
  });

  it("gives each SDK the base it actually wants", () => {
    const ep = proxyEndpoints(ROOT, "codex");
    expect(ep.anthropicBase).toBe(`${ROOT}/proxy/codex`);
    expect(ep.openAiBase).toBe(`${ROOT}/proxy/codex/v1`);
  });

  it("derives both dialects from the same prefix", () => {
    const ep = proxyEndpoints(ROOT, "codex");
    expect(ep.anthropicMessages).toBe(`${ROOT}/proxy/codex/v1/messages`);
    expect(ep.openAiChatCompletions).toBe(`${ROOT}/proxy/codex/v1/chat/completions`);
    expect(ep.models).toBe(`${ROOT}/proxy/codex/v1/models`);
  });

  it("offers image routes only under a provider", () => {
    // The unscoped path has no images handler, so advertising one would send a
    // caller to a 404.
    const scoped = proxyEndpoints(ROOT, "codex");
    expect(scoped.imagesGenerations).toBe(`${ROOT}/proxy/codex/v1/images/generations`);
    expect(scoped.imagesEdits).toBe(`${ROOT}/proxy/codex/v1/images/edits`);

    const unscoped = proxyEndpoints(ROOT);
    expect(unscoped.imagesGenerations).toBeNull();
    expect(unscoped.imagesEdits).toBeNull();
  });

  it("leaves the default endpoints exactly where they have always been", () => {
    // Existing users have these pasted into their tooling.
    const ep = proxyEndpoints(ROOT);
    expect(ep.anthropicMessages).toBe(`${ROOT}/proxy/v1/messages`);
    expect(ep.openAiChatCompletions).toBe(`${ROOT}/proxy/v1/chat/completions`);
    expect(ep.anthropicBase).toBe(`${ROOT}/proxy`);
    expect(ep.openAiBase).toBe(`${ROOT}/proxy/v1`);
  });
});
