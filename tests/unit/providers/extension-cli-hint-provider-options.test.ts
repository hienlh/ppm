import { describe, expect, it } from "bun:test";
import { buildSystemPromptOption } from "../../../src/providers/claude-agent-sdk-query-options.ts";
import { buildThreadParams, joinDeveloperInstructions } from "../../../src/providers/codex-app-server/codex-thread-params.ts";

const HINT = "PPM extension commands are available through Bash: `ppm midday`.";
const permission = { sandbox: "workspace-write", approvalPolicy: "never" } as const;

describe("extension CLI hint in provider options", () => {
  it("appends to Claude's preset after the user's instructions and the design block", () => {
    expect(buildSystemPromptOption("Mine", "Design", HINT)).toEqual({
      type: "preset", preset: "claude_code", append: `Mine\n\nDesign\n\n${HINT}`,
    });
    expect(buildSystemPromptOption(undefined, undefined, HINT)).toEqual({ type: "preset", preset: "claude_code", append: HINT });
    expect(buildSystemPromptOption()).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("joins Codex's developer instructions after the design block, and sends nothing when both are empty", () => {
    expect(joinDeveloperInstructions("Design", HINT)).toBe(`Design\n\n${HINT}`);
    expect(joinDeveloperInstructions(undefined, HINT)).toBe(HINT);
    expect(joinDeveloperInstructions(" ", undefined)).toBeUndefined();
    expect(buildThreadParams({ cwd: "/p", permission, developerInstructions: joinDeveloperInstructions(undefined, HINT) }).developerInstructions)
      .toBe(HINT);
    expect(buildThreadParams({ cwd: "/p", permission, developerInstructions: joinDeveloperInstructions() })).not.toHaveProperty("developerInstructions");
  });
});
