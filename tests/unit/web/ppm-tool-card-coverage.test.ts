import { describe, expect, it } from "bun:test";
import { sessionServerToolDefinitions } from "../../../src/services/session-collab/session-server-tool-list";
import { TAB_TOOLS_MCP_TOOL_DEFINITIONS } from "../../../src/services/tab-tools-mcp/tab-tools-mcp-tool-list";
import { dbToolDefinitions } from "../../../src/services/db-ai-tools/db-ai-tools-tool";
import { ASSISTANT_TOOL_DEFINITIONS } from "../../../src/services/assistant-mcp/assistant-mcp-tools";
import { CODEX_DESIGN_MCP_SERVER, CLAUDE_DESIGN_MCP_SERVER, DESIGN_MCP_TOOL_DEFINITIONS } from "../../../src/services/design/mcp/design-mcp-tool";
import { CLAUDE_SESSION_COLLAB_MCP_SERVER, CODEX_SESSION_COLLAB_MCP_SERVER } from "../../../src/shared/session-collab";
import { CLAUDE_TAB_TOOLS_MCP_SERVER, CODEX_TAB_TOOLS_MCP_SERVER } from "../../../src/shared/tab-open-protocol";
import { CLAUDE_DB_TOOLS_MCP_SERVER, CODEX_DB_TOOLS_MCP_SERVER } from "../../../src/shared/db-ai-tools";
import { CLAUDE_ASSISTANT_MCP_SERVER, CODEX_ASSISTANT_MCP_SERVER } from "../../../src/shared/assistant-tool-names";
import { PPM_TOOLS_NAMED_ONLY, ppmToolHasOwnLine, ppmToolName, ppmToolSummary } from "../../../src/web/lib/ppm-tool-call";
import { sessionCollabToolOf } from "../../../src/web/lib/session-collab-tool-call";
import { deviceToolOf, tabToolCall } from "../../../src/web/lib/tab-tool-call";
import { vaultToolOf } from "../../../src/web/lib/vault-tool-call";
import { dbToolOf } from "../../../src/web/lib/db-tool-call";

/**
 * Every MCP tool PPM serves to a chat has a card in the chat: a card of its own, or the ordinary
 * card with a readable name and a line read from its input and output. The tools come from the
 * lists each endpoint answers `tools/list` with, so a tool added to an endpoint is checked here
 * without anyone remembering to list it. A tool of the PPM Assistant's own server only needs a
 * readable name. Both providers' names are checked: Claude's `mcp__<server>__<tool>` and Codex's
 * `<server>:<tool>`.
 */
const SERVERS = [
  { label: "ppm-sessions (/api/sessions-mcp)", claude: CLAUDE_SESSION_COLLAB_MCP_SERVER, codex: CODEX_SESSION_COLLAB_MCP_SERVER, tools: sessionServerToolDefinitions(), namedOnly: false },
  { label: "ppm-tabs (/api/tab-tools-mcp)", claude: CLAUDE_TAB_TOOLS_MCP_SERVER, codex: CODEX_TAB_TOOLS_MCP_SERVER, tools: TAB_TOOLS_MCP_TOOL_DEFINITIONS, namedOnly: false },
  { label: "ppm-db (/api/db-tools-mcp)", claude: CLAUDE_DB_TOOLS_MCP_SERVER, codex: CODEX_DB_TOOLS_MCP_SERVER, tools: dbToolDefinitions("", () => true), namedOnly: false },
  { label: "ppm-design (/api/design-mcp)", claude: CLAUDE_DESIGN_MCP_SERVER, codex: CODEX_DESIGN_MCP_SERVER, tools: DESIGN_MCP_TOOL_DEFINITIONS, namedOnly: false },
  { label: "ppm-assistant (/api/assistant-mcp)", claude: CLAUDE_ASSISTANT_MCP_SERVER, codex: CODEX_ASSISTANT_MCP_SERVER, tools: ASSISTANT_TOOL_DEFINITIONS, namedOnly: true },
];

const FIX = "Add its line to src/web/lib/ppm-tool-summaries-tasks.ts or ppm-tool-summaries-sessions.ts "
  + "(or give it a card of its own, routed in src/web/components/chat/tool-cards.tsx); if a readable name is "
  + "really enough, list it with the reason in PPM_TOOLS_NAMED_ONLY in src/web/lib/ppm-tool-call.ts. "
  + "See CLAUDE.md → \"Every PPM tool gets a card\".";

/** A card of its own: routed before the ordinary card in `ToolCard`. */
function ownCard(name: string): boolean {
  return !!(sessionCollabToolOf(name) || tabToolCall(name, { path: "a" }) || deviceToolOf(name) || vaultToolOf(name) || dbToolOf(name));
}

/** What is wrong with a tool's card, or null when it has one. */
function missingCard(name: string, tool: string, namedOnly: boolean): string | null {
  if (ownCard(name)) return null;
  if (!ppmToolName(name)) return `${name} is not read as a PPM tool name (src/web/lib/ppm-tool-call.ts SERVERS)`;
  const summary = ppmToolSummary(name, {}, { isError: false });
  if (!summary || !summary.label.trim() || /__|:|_/.test(summary.label) || summary.label === tool) {
    return `${name} shows no readable name (got ${JSON.stringify(summary?.label)})`;
  }
  if (namedOnly || tool in PPM_TOOLS_NAMED_ONLY || ppmToolHasOwnLine(tool)) return null;
  return `${name} shows only its humanized name "${summary.label}", with no line read from its input and output`;
}

describe("every PPM tool has a card in the chat", () => {
  for (const server of SERVERS) {
    it(`${server.label}: ${server.tools.length} tools`, () => {
      expect(server.tools.length).toBeGreaterThan(0);
      const problems: string[] = [];
      for (const def of server.tools) {
        for (const name of [`mcp__${server.claude}__${def.name}`, `${server.codex}:${def.name}`]) {
          const problem = missingCard(name, def.name, server.namedOnly);
          if (problem) problems.push(problem);
        }
      }
      expect(problems, `${problems.join("\n")}\n${FIX}`).toEqual([]);
    });
  }

  it("lists in PPM_TOOLS_NAMED_ONLY only tools some endpoint still serves", () => {
    const served = new Set(SERVERS.flatMap((s) => s.tools.map((t) => t.name)));
    expect(Object.keys(PPM_TOOLS_NAMED_ONLY).filter((tool) => !served.has(tool))).toEqual([]);
  });

  it("fails for a new tool that has no card, and says which file to change", () => {
    expect(missingCard("mcp__ppm-sessions__ppm_task_archive", "ppm_task_archive", false)).toContain("no line read from its input and output");
    expect(missingCard("ppm_tabs:session_export", "session_export", false)).toContain("no line read");
    expect(missingCard("mcp__ppm-assistant__git_rebase", "git_rebase", true)).toBeNull();
    expect(FIX).toContain("src/web/lib/ppm-tool-call.ts");
  });
});
