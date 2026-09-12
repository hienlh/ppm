import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodexUsageRows } from "../../../src/web/components/settings/accounts/codex-usage-rows.tsx";
import type { LimitBucket } from "../../../src/types/chat.ts";

/** A bucket the way the codex parser builds one, resetting `mins` from now. */
function bucket(util: number, mins: number, windowHours: number): LimitBucket {
  return {
    utilization: util,
    resetsAt: new Date(Date.now() + mins * 60_000).toISOString(),
    resetsInMinutes: windowHours <= 5 ? mins : null,
    resetsInHours: windowHours > 5 ? Math.round((mins / 60) * 100) / 100 : null,
    windowHours,
  };
}

describe("CodexUsageRows", () => {
  test("shows the reset countdown the server sent for each window", () => {
    const html = renderToStaticMarkup(
      <CodexUsageRows
        usage={{
          fiveHour: 0.01,
          sevenDay: 0.0,
          session: bucket(0.01, 195, 5),
          weekly: bucket(0, 4 * 1440 + 60, 168),
        }}
      />,
    );
    expect(html).toContain("3h 15m");
    expect(html).toContain("4d 1h");
    expect(html).toContain("1%");
    expect(html).toContain("0%");
  });

  test("renders the percentages without a countdown when no bucket came back", () => {
    const html = renderToStaticMarkup(<CodexUsageRows usage={{ fiveHour: 0.42, sevenDay: 0.07 }} />);
    expect(html).toContain("42%");
    expect(html).toContain("7%");
    expect(html).not.toContain("↻");
  });

  test("keeps both rows with an em dash when the quota read failed entirely", () => {
    const html = renderToStaticMarkup(<CodexUsageRows usage={{}} />);
    expect(html).toContain("5-Hour Session");
    expect(html).toContain("Weekly");
    expect(html.match(/—/g)?.length).toBe(2);
  });
});
