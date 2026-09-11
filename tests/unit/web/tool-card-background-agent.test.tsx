import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCard } from "../../../src/web/components/chat/tool-cards.tsx";
import type { ChatEvent } from "../../../src/types/chat.ts";

/** The result an Agent tool returns the moment it spawns a backgrounded subagent. */
const LAUNCH_ACK: ChatEvent = {
  type: "tool_result",
  output: "Async agent launched successfully. Agent id: a8531e43894c304c9",
  toolUseId: "toolu_01A",
};

function agentCall(bgStatus?: "completed" | "failed" | "stopped"): ChatEvent {
  return {
    type: "tool_use",
    tool: "Agent",
    input: { description: "Techlead review NX-5175 new round" },
    toolUseId: "toolu_01A",
    children: Array.from({ length: 16 }, (_, i) => (
      { type: "tool_use", tool: "Read", input: { file_path: `/repo/f${i}.ts` } } as ChatEvent
    )),
    ...(bgStatus && { bgStatus }),
  };
}

/**
 * Each icon carries its name as `data-icon`, so the card's state is readable off
 * the markup. (These were lucide's own `lucide-circle-check` classes until the
 * chrome moved to Fluent; `fluent-icon.tsx` keeps the hook as an attribute
 * rather than a class, so no stylesheet can come to depend on it.)
 */
const spinning = (html: string) => html.includes('data-icon="Loader2"');
const checked = (html: string) => html.includes('data-icon="CheckCircle2"');
const crossed = (html: string) => html.includes('data-icon="XCircle"');

describe("ToolCard — backgrounded Agent", () => {
  test("stays running on the launch ack, even after the parent turn ended", () => {
    // `completed` is what the transcript passes once streaming stops. It says the turn
    // finished, not the agent — the card must not read it as the agent being done.
    const html = renderToStaticMarkup(
      <ToolCard tool={agentCall()} result={LAUNCH_ACK} completed />,
    );

    expect(spinning(html)).toBe(true);
    expect(checked(html)).toBe(false);
    expect(html).toContain("running");
    expect(html).toContain("16 steps");
  });

  test("settles to a check once the task notification reports completion", () => {
    const html = renderToStaticMarkup(
      <ToolCard tool={agentCall("completed")} result={LAUNCH_ACK} completed />,
    );

    expect(checked(html)).toBe(true);
    expect(spinning(html)).toBe(false);
    expect(html).not.toContain("running");
  });

  test("shows failure when the agent died rather than finished", () => {
    for (const status of ["failed", "stopped"] as const) {
      const html = renderToStaticMarkup(
        <ToolCard tool={agentCall(status)} result={LAUNCH_ACK} completed />,
      );
      expect(crossed(html)).toBe(true);
      expect(checked(html)).toBe(false);
    }
  });

  test("a synchronous Agent is done on its result, with no notification to wait for", () => {
    const report: ChatEvent = {
      type: "tool_result",
      output: "## Findings\n\nThe money transformer round-trips losslessly.",
      toolUseId: "toolu_01A",
    };
    const html = renderToStaticMarkup(<ToolCard tool={agentCall()} result={report} />);

    expect(checked(html)).toBe(true);
    expect(spinning(html)).toBe(false);
  });

  test("an Agent with no result yet spins, as any pending tool does", () => {
    const html = renderToStaticMarkup(<ToolCard tool={agentCall()} />);

    expect(spinning(html)).toBe(true);
    expect(checked(html)).toBe(false);
  });
});
