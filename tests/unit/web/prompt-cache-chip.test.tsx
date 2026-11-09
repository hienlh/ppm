/**
 * The prompt cache chip in the composer bar: shows nothing while warm or unknown,
 * renders red when cold with the idle duration.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptCacheChip } from "../../../src/web/components/chat/prompt-cache-chip";
import type { PromptCacheState } from "../../../src/shared/prompt-cache-idle";

describe("PromptCacheChip", () => {
  const ttlMs = 3600000; // 1 hour in ms
  const now = Date.now();

  it("renders nothing when promptCache is null", () => {
    const html = renderToStaticMarkup(<PromptCacheChip promptCache={null} />);
    expect(html).not.toContain("data-prompt-cache");
  });

  it("renders nothing when cache is warm", () => {
    const state: PromptCacheState = {
      ttlMs,
      lastTurnEndedAt: now - 60000, // 1 minute ago
      billedPrefixTokens: 10000,
      contextTokens: 5000,
    };
    const html = renderToStaticMarkup(<PromptCacheChip promptCache={state} />);
    expect(html).not.toContain("data-prompt-cache");
  });

  it("renders nothing when cache is unknown (no lastTurnEndedAt)", () => {
    const state: PromptCacheState = {
      ttlMs,
      billedPrefixTokens: 100, // Below threshold
    };
    const html = renderToStaticMarkup(<PromptCacheChip promptCache={state} />);
    expect(html).not.toContain("data-prompt-cache");
  });

  it("renders nothing when billedPrefixTokens is below threshold", () => {
    const state: PromptCacheState = {
      ttlMs,
      lastTurnEndedAt: now - 7200000, // 2 hours ago
      billedPrefixTokens: 100, // Below PREFIX_WARN_TOKENS threshold
    };
    const html = renderToStaticMarkup(<PromptCacheChip promptCache={state} />);
    expect(html).not.toContain("data-prompt-cache");
  });

  it("renders cold indicator when cache expired", () => {
    const state: PromptCacheState = {
      ttlMs,
      lastTurnEndedAt: now - 7200000, // 2 hours ago (beyond ttl)
      billedPrefixTokens: 100000, // Above threshold
      contextTokens: 50000,
    };
    const html = renderToStaticMarkup(<PromptCacheChip promptCache={state} />);
    expect(html).toContain("data-prompt-cache=\"cold\"");
    expect(html).toContain("Prompt cache expired");
  });

  it("renders cold indicator when cache is compacted", () => {
    const state: PromptCacheState = {
      ttlMs,
      lastTurnEndedAt: now - 300000, // 5 minutes ago
      billedPrefixTokens: 100000,
      contextTokens: 50000,
      compactedAt: now - 600000, // 10 minutes ago
    };
    const html = renderToStaticMarkup(<PromptCacheChip promptCache={state} />);
    expect(html).toContain("data-prompt-cache=\"cold\"");
    expect(html).toContain("compacted");
  });

  it("shows 'no token figure' message for compacted cache", () => {
    const state: PromptCacheState = {
      ttlMs,
      billedPrefixTokens: 100000,
      compactedAt: now - 3600000, // 1 hour ago
    };
    const html = renderToStaticMarkup(<PromptCacheChip promptCache={state} />);
    expect(html).toContain("Compacted");
    // No token figure because it's compacted.
    expect(html).not.toContain("re-sends");
  });

  it("includes context tokens in tooltip when available", () => {
    const state: PromptCacheState = {
      ttlMs,
      lastTurnEndedAt: now - 7200000, // 2 hours ago
      billedPrefixTokens: 100000,
      contextTokens: 42000, // 42k tokens
    };
    const html = renderToStaticMarkup(<PromptCacheChip promptCache={state} />);
    expect(html).toContain("42k");
  });

  it("formats idle duration correctly", () => {
    const state: PromptCacheState = {
      ttlMs,
      lastTurnEndedAt: now - 3661000, // 1 hour 1 minute 1 second ago
      billedPrefixTokens: 100000,
    };
    const html = renderToStaticMarkup(<PromptCacheChip promptCache={state} />);
    // formatIdleDuration should produce "1h 1m"
    expect(html).toContain("1h 1m");
  });
});
