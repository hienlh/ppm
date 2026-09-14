import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodexUsagePanel } from "../../../src/web/components/chat/codex-usage-panel.tsx";
import type { LimitBucket } from "../../../src/types/chat.ts";

function bucket(utilization: number, mins: number, windowHours: number): LimitBucket {
  return {
    utilization,
    resetsAt: new Date(Date.now() + mins * 60_000).toISOString(),
    resetsInMinutes: windowHours <= 5 ? mins : null,
    resetsInHours: windowHours > 5 ? Math.round((mins / 60) * 100) / 100 : null,
    windowHours,
  };
}

describe("CodexUsagePanel", () => {
  test("shows reset countdowns from the session usage buckets", () => {
    const html = renderToStaticMarkup(
      <CodexUsagePanel
        onClose={() => {}}
        usage={{
          fiveHour: 0.78,
          sevenDay: 0.15,
          session: bucket(0.78, 75, 5),
          weekly: bucket(0.15, 2 * 1440, 168),
        }}
      />,
    );

    expect(html).toContain("1h 15m");
    expect(html).toContain("2d");
    expect(html).toContain("78%");
    expect(html).toContain("15%");
  });
});
