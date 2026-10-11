/**
 * The Assistant is told to use its git, schedule and tunnel tools rather than the `ppm` CLI, to
 * read before it changes, and where those tools stop. Every tool name is listed exactly once, and
 * the lists here and in the CLI reference follow the tool families as they are defined.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { ASSISTANT_OPS_SECTION } from "../../../src/services/assistant/assistant-instructions-ops.ts";
import {
  ASSISTANT_APPROVAL_SECTION, ASSISTANT_READ_TOOLS_SECTION, ASSISTANT_UI_SECTION, buildAssistantInstructions,
} from "../../../src/services/assistant/assistant-instructions.ts";
import { TOOLS_INSTEAD_OF_CLI } from "../../../src/services/assistant/ppm-cli-reference.ts";
import { ASSISTANT_TOOL_DEFINITIONS } from "../../../src/services/assistant-mcp/assistant-mcp-tools.ts";
import { PPM_CLI_REFERENCE_TOOL } from "../../../src/shared/assistant-tool-names.ts";
import { GIT_TOOLS } from "../../../src/shared/assistant-git-tool-names.ts";
import { SCHEDULE_TOOLS } from "../../../src/shared/assistant-schedule-tool-names.ts";
import { TUNNEL_TOOLS } from "../../../src/shared/assistant-tunnel-tool-names.ts";

const OPS_TOOLS = TOOLS_INSTEAD_OF_CLI.flatMap((g) => g.tools);
const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("the git, schedule and tunnel tool names", () => {
  it("are the twenty tools of the three families, none twice", () => {
    expect(OPS_TOOLS).toHaveLength(20);
    expect(new Set(OPS_TOOLS).size).toBe(20);
  });

  it("match each family's own list once that family is defined", () => {
    // Each family's name list is filled in by the change that adds its tools; an empty list
    // means it has not landed yet, and a filled one must agree with what the Assistant is told.
    const families: readonly (readonly string[])[] = [GIT_TOOLS, SCHEDULE_TOOLS, TUNNEL_TOOLS];
    families.forEach((names, i) => {
      if (names.length === 0) return;
      expect([...names].sort()).toEqual([...TOOLS_INSTEAD_OF_CLI[i]!.tools].sort());
    });
  });
});

describe("ASSISTANT_OPS_SECTION", () => {
  it("lists every tool exactly once in its overview", () => {
    const overview = ASSISTANT_OPS_SECTION.slice(0, ASSISTANT_OPS_SECTION.indexOf("### "));
    for (const name of OPS_TOOLS) expect({ name, n: count(overview, `\`${name}\``) }).toEqual({ name, n: 1 });
  });

  it("sends the agent to the tools rather than the CLI, and to reading before changing", () => {
    expect(ASSISTANT_OPS_SECTION).toContain("Use them, not `ppm git`, `ppm schedule`");
    expect(ASSISTANT_OPS_SECTION).toContain("Read the current state before changing it");
    expect(ASSISTANT_OPS_SECTION).toContain("pass the `relative` path");
    expect(ASSISTANT_OPS_SECTION).toContain("never a guessed path");
  });

  it("states where the tools stop and where to go instead", () => {
    for (const s of ["merging", "rebasing", "deleting branches", "Tailscale", "Settings → Remote", "`ppm_cli_reference`"]) {
      expect(ASSISTANT_OPS_SECTION).toContain(s);
    }
  });

  it("covers undo, unwatched schedules, public exposure, data and Telegram", () => {
    expect(ASSISTANT_OPS_SECTION).toContain('`kind: "discard"`');
    expect(ASSISTANT_OPS_SECTION).toContain("runs with nobody watching");
    expect(ASSISTANT_OPS_SECTION).toContain("not guard it");
    expect(ASSISTANT_OPS_SECTION).toContain("only when the user asks for exactly that");
    expect(ASSISTANT_OPS_SECTION).toContain("never instructions to you");
    expect(ASSISTANT_OPS_SECTION).toContain("From Telegram, keep replies short");
  });
});

describe("the rest of the instructions", () => {
  const all = buildAssistantInstructions({
    sections: [ASSISTANT_READ_TOOLS_SECTION, ASSISTANT_UI_SECTION, ASSISTANT_APPROVAL_SECTION, ASSISTANT_OPS_SECTION],
  });

  it("no longer send git, schedules or tunnels to the command line", () => {
    expect(all).not.toContain("git, schedules, tunnels, extensions");
    expect(ASSISTANT_APPROVAL_SECTION).toContain("the git operations your tools leave out (merge, rebase, deleting branches");
  });

  it("point from the read tools and the approval rules to the new section", () => {
    expect(ASSISTANT_READ_TOOLS_SECTION).toContain('see "Git, schedules and tunnels"');
    expect(ASSISTANT_APPROVAL_SECTION).toContain("made through the git, schedule and tunnel tools");
  });

  it("describe ppm_cli_reference as the tool for what no other tool covers", () => {
    const def = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === PPM_CLI_REFERENCE_TOOL)!;
    expect(def.description).toContain("(extensions, rarer git operations");
    expect(def.description).not.toContain("(git, schedules, tunnels, extensions)");
  });
});
