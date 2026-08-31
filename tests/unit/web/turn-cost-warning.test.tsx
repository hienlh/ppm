import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnCostWarning } from "../../../src/web/components/chat/turn-cost-warning.tsx";
import { buildTurnUsage } from "../../../src/shared/turn-usage.ts";

/** The costly case: a resumed session whose transcript was re-sent uncached. */
const coldUsage = buildTurnUsage(
  {
    "claude-opus-5": {
      inputTokens: 620,
      outputTokens: 1_800,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 318_000,
      contextWindow: 1_000_000,
      costUSD: 2.41,
    },
  },
  { coldReason: "tab_closed" },
)!;

describe("TurnCostWarning", () => {
  test("renders nothing for a turn that reused its cached prefix", () => {
    const warm = buildTurnUsage({
      "claude-opus-5": {
        inputTokens: 480,
        outputTokens: 2_400,
        cacheReadInputTokens: 317_200,
        cacheCreationInputTokens: 900,
        contextWindow: 1_000_000,
        costUSD: 0.23,
      },
    })!;
    expect(renderToStaticMarkup(<TurnCostWarning usage={warm} />)).toBe("");
  });

  test("renders nothing for a new session's opening turn", () => {
    const firstTurn = buildTurnUsage({
      "claude-opus-5": {
        inputTokens: 1_200,
        outputTokens: 900,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 42_000,
        contextWindow: 1_000_000,
        costUSD: 0.4,
      },
    })!;
    expect(renderToStaticMarkup(<TurnCostWarning usage={firstTurn} />)).toBe("");
  });

  test("states the cache share and the cost multiple for a costly turn", () => {
    const html = renderToStaticMarkup(<TurnCostWarning usage={coldUsage} />);
    expect(html).toContain("0%");
    expect(html).toContain("319k");
    // ~1.25x write vs 0.1x read on the whole prefix ⇒ an order of magnitude.
    expect(html).toMatch(/1[0-9]\.[0-9]x/);
  });

  test("keeps the breakdown collapsed until asked for", () => {
    const html = renderToStaticMarkup(<TurnCostWarning usage={coldUsage} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Written to cache");
    expect(html).not.toContain("tab disconnected");
  });

  test("survives a turn the SDK reported without a model name", () => {
    const nameless = buildTurnUsage(
      { "": { inputTokens: 100, cacheCreationInputTokens: 90_000, outputTokens: 10 } },
      { coldReason: "resume" },
    )!;
    expect(() => renderToStaticMarkup(<TurnCostWarning usage={nameless} />)).not.toThrow();
  });
});
