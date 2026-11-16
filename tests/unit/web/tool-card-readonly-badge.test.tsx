import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { READONLY_UNASKED_NOTE, ToolCard } from "../../../src/web/components/chat/tool-cards.tsx";
import type { ChatEvent } from "../../../src/types/chat.ts";

/**
 * A PPM Assistant command that ran with no card says so on its tool card, collapsed or not, so
 * the user can see what ran unasked. Only a result PPM marked `autoApproved: "readonly"` shows
 * it: an ordinary result, an error, or a card still running shows nothing.
 */
const call = (tool: string, input: Record<string, unknown>): ChatEvent => ({ type: "tool_use", tool, input, toolUseId: "toolu_ro" });
const result = (extra: Partial<Extract<ChatEvent, { type: "tool_result" }>> = {}): ChatEvent => ({
  type: "tool_result", output: "On branch main\nnothing to commit", toolUseId: "toolu_ro", ...extra,
});

const BASH = call("Bash", { command: "git -C /home/u/app status" });
const POWERSHELL = call("PowerShell", { command: "Get-ChildItem C:\\work\\app" });

describe("ToolCard — read-only command that ran without asking", () => {
  test("shows the note on a Bash and a PowerShell card whose result was auto-approved", () => {
    for (const tool of [BASH, POWERSHELL]) {
      const html = renderToStaticMarkup(<ToolCard tool={tool} result={result({ autoApproved: "readonly", exitCode: 0 })} />);
      expect(html).toContain(READONLY_UNASKED_NOTE);
      expect(html).toContain('data-testid="tool-ran-readonly"');
    }
    expect(READONLY_UNASKED_NOTE).toBe("Read-only · ran without asking");
  });

  test("shows nothing for a command the user approved or one that ran in a plain chat", () => {
    const html = renderToStaticMarkup(<ToolCard tool={BASH} result={result()} />);
    expect(html).not.toContain(READONLY_UNASKED_NOTE);
  });

  test("shows nothing while the command is still running", () => {
    const html = renderToStaticMarkup(<ToolCard tool={BASH} />);
    expect(html).not.toContain(READONLY_UNASKED_NOTE);
  });
});
