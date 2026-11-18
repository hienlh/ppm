import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCard } from "../../../src/web/components/chat/tool-cards.tsx";
import type { ChatEvent } from "../../../src/types/chat.ts";

/**
 * PPM's own tools draw a readable line in the ordinary tool card: a name in place of the raw
 * `mcp__ppm-…__x`, what the call was about, a button for the task or chat it named, and where it
 * stands (running, done, failed, stopped). Every other tool's card is left as it was.
 */
const call = (tool: string, input: Record<string, unknown>): ChatEvent => ({ type: "tool_use", tool, input, toolUseId: "toolu_ppm" });
const result = (output: string, isError = false): ChatEvent => ({ type: "tool_result", output, toolUseId: "toolu_ppm", ...(isError ? { isError } : {}) });

const CREATE = call("mcp__ppm-sessions__ppm_task_create", { title: "Fix login" });

describe("ToolCard — PPM tools", () => {
  test("a created task reads as one line with its code to open, not the raw tool name", () => {
    const html = renderToStaticMarkup(<ToolCard tool={CREATE} result={result('[{"type":"text","text":"Created: ppm/151 \\"Fix login\\" — now revision 1."}]')} />);
    expect(html).toContain("Created task");
    expect(html).toContain("ppm/151 · Fix login");
    expect(html).toContain('data-ppm-tool-task="ppm/151"');
    expect(html).toContain('data-ppm-tool-card="mcp__ppm-sessions__ppm_task_create"');
    expect(html).not.toContain(">mcp__ppm-sessions__ppm_task_create<");
  });

  test("a running call spins, a stopped one says so, a failed one shows why", () => {
    expect(renderToStaticMarkup(<ToolCard tool={CREATE} />)).toContain("animate-spin");
    const stopped = renderToStaticMarkup(<ToolCard tool={CREATE} completed />);
    expect(stopped).toContain('data-ppm-tool-stopped=""');
    expect(stopped).not.toContain("text-success");
    const failed = renderToStaticMarkup(<ToolCard tool={CREATE} result={result("A task needs a title.\nmore", true)} />);
    expect(failed).toContain('data-ppm-tool-error=""');
    expect(failed).toContain("A task needs a title.");
    expect(failed).toContain("Create task");
  });

  test("a turn read links its chat, a Codex search counts its results", () => {
    const read = renderToStaticMarkup(<ToolCard tool={call("mcp__ppm-tabs__read_session_turns", { session_id: "s1", turn_ids: ["t1"] })} projectName="ppm" />);
    expect(read).toContain('data-ppm-tool-open-chat="s1"');
    const search = renderToStaticMarkup(<ToolCard tool={call("ppm_tabs:search_sessions", { server: "ppm_tabs", tool: "search_sessions", arguments: { query: "NX-6317" } })}
      result={result('No session matches "NX-6317".')} />);
    expect(search).toContain("Searched sessions");
    expect(search).toContain("0 results");
  });

  test("a db_query card counts the rows it returned", () => {
    const html = renderToStaticMarkup(<ToolCard tool={call("mcp__ppm-db__db_query", { connection: "Prod", sql: "SELECT 1" })} result={result("Statement 1 returned 3 rows:\n")} />);
    expect(html).toContain("Database query");
    expect(html).toContain("3 rows");
  });

  test("other tools keep their card as it was", () => {
    const html = renderToStaticMarkup(<ToolCard tool={call("mcp__playwright__browser_click", { ref: "e1" })} completed />);
    expect(html).toContain("mcp__playwright__browser_click");
    expect(html).not.toContain("data-ppm-tool");
  });
});
