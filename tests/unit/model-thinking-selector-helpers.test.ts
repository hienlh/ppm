import { describe, it, expect } from "bun:test";
import {
  EFFORT_OPTIONS,
  effortLabel,
  chipLabel,
  effortNotice,
  noticeText,
  shownEffort,
} from "../../src/web/components/chat/model-thinking-selector-helpers.ts";

describe("effort options", () => {
  it("maps UI 'Extra' to SDK value 'xhigh' and never uses 'extra'", () => {
    const extra = EFFORT_OPTIONS.find((o) => o.label === "Extra");
    expect(extra?.value).toBe("xhigh");
    expect(EFFORT_OPTIONS.some((o) => o.value === "extra")).toBe(false);
  });

  it("has exactly the 5 SDK effort values in order", () => {
    expect(EFFORT_OPTIONS.map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("marks High as the default", () => {
    expect(EFFORT_OPTIONS.find((o) => o.default)?.value).toBe("high");
  });
});

describe("effortLabel", () => {
  it("returns the UI label for a value", () => {
    expect(effortLabel("xhigh")).toBe("Extra");
    expect(effortLabel("high")).toBe("High");
    expect(effortLabel("max")).toBe("Max");
  });

  it("falls back to the raw value when unknown", () => {
    expect(effortLabel("mystery")).toBe("mystery");
  });
});

describe("chipLabel", () => {
  it("combines model display + effort label", () => {
    expect(chipLabel("Opus 5", "high")).toBe("Opus 5 · High");
    expect(chipLabel("Opus 5", "xhigh")).toBe("Opus 5 · Extra");
  });

  it("shows model only when effort is null", () => {
    expect(chipLabel("Opus 5", null)).toBe("Opus 5");
  });
});

describe("effort notice", () => {
  const userEnv = { value: "max", source: "userSettings" as const, file: "~/.claude/settings.json" };

  it("names the variable and the file that override the pick", () => {
    const status = { env: userEnv, observed: { requested: "high" as const, applied: "max" as const, model: "claude-opus-5-5[1m]" } };
    const shown = shownEffort("high", status);
    expect(shown).toEqual({ pick: "high", level: "max", reason: "env" });
    const notice = effortNotice(shown, status, "Opus 5.5")!;
    expect(notice.title).toBe("Effort is set to Max outside PPM");
    expect(noticeText(notice.detail)).toBe(
      "CLAUDE_CODE_EFFORT_LEVEL=max in ~/.claude/settings.json overrides the effort picked here. Remove it there to use the effort picked in PPM.",
    );
    expect(notice.detail).toContainEqual({ code: "CLAUDE_CODE_EFFORT_LEVEL=max" });
    expect(notice.detail).toContainEqual({ code: "~/.claude/settings.json" });
  });

  it("says what the model makes of the variable's level", () => {
    const status = { env: userEnv, observed: { requested: "high" as const, applied: "high" as const, model: "claude-opus-4-5" } };
    expect(noticeText(effortNotice(shownEffort("high", status), status, "Opus 4.5")!.detail)).toContain("Opus 4.5 runs it as High.");
  });

  it("tells a variable that leaves effort to the model apart from one that sets a level", () => {
    const auto = { env: { value: "auto", source: "environment" as const }, observed: { requested: "high" as const, applied: null, model: "claude-opus-5-5" } };
    const notice = effortNotice(shownEffort("high", auto), auto, "Opus 5.5")!;
    expect(notice.title).toBe("Effort is left to the model");
    expect(noticeText(notice.detail)).toBe(
      "CLAUDE_CODE_EFFORT_LEVEL=auto in the environment PPM runs in overrides the effort picked here: no effort is sent, so Opus 5.5's default applies. Remove it there to use the effort picked in PPM.",
    );
    // A cap makes the CLI send the model's default, clamped, instead of nothing.
    const capped = { ...auto, observed: { ...auto.observed, applied: "high" as const } };
    expect(noticeText(effortNotice(shownEffort("high", capped), capped, "Opus 5.5")!.detail)).toContain("Claude Code sends Opus 5.5's default, High.");
  });

  it("does not say nothing is sent for auto or a number under a cap", () => {
    const cap = { value: "low" as const, source: "userSettings" as const };
    const auto = { env: { value: "auto", source: "userSettings" as const }, cap };
    expect(noticeText(effortNotice(shownEffort("high", auto), auto, "Opus 5.5")!.detail)).toContain("Claude Code sends Opus 5.5's default effort, capped at Low.");
    // Over a higher cap the level is the CLI's to say, and the sentence still names the cap.
    const autoXhigh = { ...auto, cap: { value: "xhigh" as const, source: "userSettings" as const } };
    const unknown = shownEffort("high", autoXhigh);
    expect(unknown.level).toBeNull();
    expect(chipLabel("Opus 5.5", unknown.level)).toBe("Opus 5.5");
    expect(noticeText(effortNotice(unknown, autoXhigh, "Opus 5.5")!.detail)).toContain("Claude Code sends Opus 5.5's default effort, capped at Extra.");
    const budget = { env: { value: "32000", source: "environment" as const }, cap: { value: "medium" as const, source: "userSettings" as const } };
    const notice = effortNotice(shownEffort("high", budget), budget, "Opus 5.5")!;
    expect(notice.title).toBe("Effort is set to Medium outside PPM");
    expect(noticeText(notice.detail)).toContain("with a maxEffortLevel set, Claude Code runs it as Medium.");
  });

  it("explains a cap and a model limit, and stays quiet when the pick is what runs", () => {
    const cap = { cap: { value: "high" as const, source: "projectSettings" as const, file: ".claude/settings.json" } };
    const capped = effortNotice(shownEffort("max", cap), cap, "Opus 5.5")!;
    expect(capped.title).toBe("Effort is capped at High");
    expect(noticeText(capped.detail)).toBe('maxEffortLevel: "high" in .claude/settings.json lowers any effort picked above it.');

    const haiku = { supported: [], observed: { requested: "high" as const, applied: null, model: "claude-haiku-4-5-20251001" } };
    expect(effortNotice(shownEffort("high", haiku), haiku, "Haiku 4.5")!.title).toBe("Haiku 4.5 takes no effort level");

    const older = { observed: { requested: "max" as const, applied: "high" as const, model: "claude-opus-4-5" } };
    expect(noticeText(effortNotice(shownEffort("max", older), older, "Opus 4.5")!.detail)).toBe("Max isn't available for Opus 4.5, so Claude Code runs it at High.");

    expect(effortNotice(shownEffort("high", cap), cap, "Opus 5.5")).toBeNull();
    expect(effortNotice(shownEffort(null, null), null, "Opus 5.5")).toBeNull();
  });
});
