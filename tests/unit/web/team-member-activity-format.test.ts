import { describe, expect, test } from "bun:test";
import {
  currentStep,
  formatDuration,
  shortAgentType,
} from "../../../src/web/components/chat/team-member-activity-format";
import type { TeamMemberActivity } from "../../../src/web/hooks/use-team-activity-feed";

const member = (over: Partial<TeamMemberActivity>): TeamMemberActivity => ({
  name: "dev-p1",
  workState: "working",
  sizeBytes: 0,
  ...over,
});

describe("shortAgentType", () => {
  test("keeps only the trailing segment", () => {
    expect(shortAgentType("ak-engineer:tester")).toBe("tester");
  });

  test("leaves a bare type alone and drops the meaningless default", () => {
    expect(shortAgentType("Explore")).toBe("Explore");
    expect(shortAgentType("general-purpose")).toBe("general-purpose");
    expect(shortAgentType(undefined)).toBeUndefined();
  });
});

describe("formatDuration", () => {
  const start = "2026-09-04T01:00:00.000Z";

  test("scales the unit with the elapsed time", () => {
    expect(formatDuration(start, "2026-09-04T01:00:45.000Z")).toBe("45s");
    expect(formatDuration(start, "2026-09-04T01:12:30.000Z")).toBe("12m");
    expect(formatDuration(start, "2026-09-04T02:04:00.000Z")).toBe("1h 4m");
  });

  test("measures against now when no end is given", () => {
    expect(formatDuration(new Date(Date.now() - 5_000).toISOString())).toMatch(/^\ds$/);
  });

  test("returns nothing when there is no usable range", () => {
    expect(formatDuration(undefined)).toBeUndefined();
    expect(formatDuration(undefined, start)).toBeUndefined();
    expect(formatDuration("not a date", start)).toBeUndefined();
    expect(formatDuration(start, "nonsense")).toBeUndefined();
    // A clock skew that puts the end before the start must not render "-3m".
    expect(formatDuration(start, "2026-09-04T00:57:00.000Z")).toBeUndefined();
  });
});

describe("currentStep", () => {
  test("prefers the running tool, with its argument when there is one", () => {
    expect(currentStep(member({ lastTool: "Edit", lastToolArg: "tool-cards.tsx" }))).toBe(
      "Edit: tool-cards.tsx",
    );
    expect(currentStep(member({ lastTool: "Bash" }))).toBe("Bash");
  });

  test("falls back to narration, then to the spawn description", () => {
    expect(currentStep(member({ lastNarrative: "checking the diff", description: "Phase 1" }))).toBe(
      "checking the diff",
    );
    expect(currentStep(member({ description: "Phase 1" }))).toBe("Phase 1");
    expect(currentStep(member({}))).toBeUndefined();
  });
});
