/**
 * The chat footer's context meter: the CLI's `/context` answer reduced to the rows a person
 * reads, and the popover that shows them with Compact now.
 */
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";
import { formatTokens, toContextUsageView } from "../../../src/shared/context-usage";

installDom();
const { ContextMeterPanel } = await import("../../../src/web/components/chat/context-meter");
const { api } = await import("../../../src/web/lib/api-client");
afterAll(uninstallDom);

// Shaped after Claude's get_context_usage answer.
const answer = {
  model: "claude-opus-5-5",
  percentage: 41.6,
  totalTokens: 83_200,
  maxTokens: 200_000,
  categories: [
    { id: "system_prompt", name: "System prompt", tokens: 3_100, kind: "used" },
    { id: "system_tools", name: "System tools", tokens: 14_000, kind: "used" },
    { id: "mcp_tools_deferred", name: "MCP tools (deferred)", tokens: 9_000, kind: "deferred", isDeferred: true },
    { id: "messages", name: "Messages", tokens: 66_100, kind: "used" },
    { id: "skills", name: "Skills", tokens: 0, kind: "used" },
    { id: "autocompact_buffer", name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
    { id: "free_space", name: "Free space", tokens: 83_800, kind: "free" },
  ],
};

describe("toContextUsageView", () => {
  it("keeps the in-window rows, largest used first, buffer and free space last", () => {
    const v = toContextUsageView(answer);
    expect(v.percentage).toBe(42);
    expect(v.rows.map((r) => r.id)).toEqual(["messages", "system_tools", "system_prompt", "autocompact_buffer", "free_space"]);
  });

  it("formats token counts the way the meter shows them", () => {
    expect(formatTokens(850)).toBe("850");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_000_000)).toBe("1.0M");
  });
});

describe("ContextMeterPanel", () => {
  it("shows what fills the context and compacts on request", async () => {
    const get = spyOn(api, "get").mockResolvedValue({ usage: toContextUsageView(answer) } as never);
    let compacted = 0;
    const view = await mount(<ContextMeterPanel projectName="ppm" sessionId="s-1" open lastPct={40} onCompact={() => { compacted++; }} />);
    try {
      await Bun.sleep(0);
      expect(get).toHaveBeenCalledWith("/api/project/ppm/chat/sessions/s-1/context-usage", expect.anything());
      expect(view.container.querySelector('[data-context-panel="ready"]')).not.toBeNull();
      expect(view.container.textContent).toContain("42% used");
      expect(view.container.querySelector('[data-context-row="messages"]')?.textContent).toContain("66.1k");
      const compact = [...view.container.querySelectorAll("button")].find((b) => b.textContent === "Compact now")!;
      await click(compact);
      expect(compacted).toBe(1);
    } finally {
      await view.unmount();
      get.mockRestore();
    }
  });

  it("with no live Claude process, says the breakdown needs one and keeps the last turn's figure", async () => {
    const get = spyOn(api, "get").mockResolvedValue({ usage: null } as never);
    const view = await mount(<ContextMeterPanel projectName="ppm" sessionId="s-2" open lastPct={73} />);
    try {
      await Bun.sleep(0);
      expect(view.container.querySelector('[data-context-panel="none"]')).not.toBeNull();
      expect(view.container.textContent).toContain("73% used");
      const compact = [...view.container.querySelectorAll("button")].find((b) => b.textContent === "Compact now")!;
      expect(compact.disabled).toBe(true);
    } finally {
      await view.unmount();
      get.mockRestore();
    }
  });
});
