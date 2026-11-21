/**
 * The browser halves of the settings tools: reading a call and its answer for the chat card, the
 * Changes tab's filters and badges, `/?openSettings=`, and the sections a change announces.
 */
import { describe, expect, it } from "bun:test";
import { settingsToolCall, settingsToolMessage, settingsToolResult, settingsToolTitle, approvalLabel } from "../../../src/web/lib/settings-tool-call";
import { changeHowBadges, filterChanges, undoNote } from "../../../src/web/components/settings/assistant/assistant-settings-changes-view";
import { addressWithoutSettingsLink, settingsLinkFromSearch } from "../../../src/web/lib/settings-deep-link";
import { settingsSectionOf } from "../../../src/server/routes/settings-broadcast";
import { FEATURE_INTROS } from "../../../src/shared/feature-intros";
import { featureIntroSettingsLink } from "../../../src/web/lib/onboarding/feature-intros-client";
import type { SettingChangeView } from "../../../src/shared/assistant-settings-changes";

/** A tool answer as the chat holds it: Claude's plain text, or Codex's list of content blocks. */
const mcp = (payload: unknown) => JSON.stringify(payload);
const codexBlocks = (payload: unknown) => JSON.stringify([{ type: "text", text: JSON.stringify(payload) }]);

describe("settingsToolCall", () => {
  it("reads both providers' names and only the Assistant's settings tools", () => {
    expect(settingsToolCall("mcp__ppm-assistant__settings_set", { changes: [{ key: "voice.enabled", value: true }] })?.keys).toEqual(["voice.enabled"]);
    expect(settingsToolCall("ppm_assistant:settings_install", { server: "ppm_assistant", tool: "settings_install", arguments: { component: "whisper", option: "small-q5_1" } })?.install)
      .toEqual({ component: "whisper", action: "install", option: "small-q5_1" });
    expect(settingsToolCall("mcp__ppm-assistant__projects_list", {})).toBeNull();
    expect(settingsToolCall("mcp__ppm-sessions__settings_set", {})).toBeNull();
  });
});

describe("settingsToolResult", () => {
  it("keeps only well-formed changes", () => {
    const r = settingsToolResult(mcp({ outcome: "changed", approval: "full", changes: [
      { changeId: 7, key: "voice.enabled", label: "Voice Input → Voice messages", before: "Off", after: "On" },
      { changeId: "x", key: 1 },
    ] }));
    expect(r?.changes).toHaveLength(1);
    expect(r?.approval).toBe("full");
    expect(settingsToolTitle({ tool: "settings_set", keys: ["voice.enabled"], install: null, target: null }, r)).toBe("Setting changed");
    expect(approvalLabel("full")).toBe("Full mode, no card");
  });
  it("reads Codex's content blocks the same way", () => {
    expect(settingsToolResult(codexBlocks({ outcome: "undone", changes: [] }))?.outcome).toBe("undone");
  });
  it("says in a person's words why nothing changed, and nothing under a change", () => {
    const declined = JSON.stringify({ outcome: "declined", action: "change x", reason: "no", note: "Nothing was done, and this is final" });
    expect(settingsToolMessage(declined, true, null)).toBe("Not changed: declined on the card.");
    expect(settingsToolMessage("The settings tools are off", true, null)).toBe("The settings tools are off");
    const changed = settingsToolResult(mcp({ outcome: "changed", changes: [], note: "for the AI" }));
    expect(settingsToolMessage(mcp({}), false, changed)).toBeNull();
    const stale = settingsToolResult(mcp({ outcome: "stale", changes: [], note: "It moved." }));
    expect(settingsToolMessage(mcp({}), false, stale)).toBe("It moved.");
  });
  it("answers null for an error text or an unknown outcome", () => {
    expect(settingsToolResult(mcp({ outcome: "exploded", changes: [] }))).toBeNull();
    expect(settingsToolResult("The settings tools are off")).toBeNull();
    expect(settingsToolResult(undefined)).toBeNull();
  });
});

const row = (over: Partial<SettingChangeView>): SettingChangeView => ({
  id: 1, at: 0, sessionId: "s", origin: "ppm", approval: "full", kind: "setting", key: "k", label: "L", before: false, after: true,
  beforeText: "Off", afterText: "On", note: null, undoes: null, undoneAt: null, undoneBy: null, undo: null, ...over,
});

describe("the Changes tab", () => {
  const rows = [row({ id: 1 }), row({ id: 2, kind: "install", undo: { reason: "not_undoable", detail: "x" } }), row({ id: 3, undoneAt: 5, undo: { reason: "undone" } })];
  it("filters", () => {
    expect(filterChanges(rows, "settings").map((r) => r.id)).toEqual([1, 3]);
    expect(filterChanges(rows, "installs").map((r) => r.id)).toEqual([2]);
    expect(filterChanges(rows, "undone").map((r) => r.id)).toEqual([3]);
  });
  it("says how a change came about and why it has no Undo", () => {
    expect(changeHowBadges(row({ origin: "telegram", approval: "card" })).map((b) => b.label)).toEqual(["Telegram", "Allowed on card"]);
    expect(undoNote(row({ undo: { reason: "moved", current: "Dark" } }))).toContain("now Dark");
    expect(undoNote(row({}))).toBeNull();
  });
});

describe("/?openSettings=", () => {
  it("narrows to a pane and an Assistant sub-tab, and refuses anything else", () => {
    expect(settingsLinkFromSearch("?openSettings=notifications")).toEqual({ category: "notifications", assistantTab: null });
    expect(settingsLinkFromSearch("?openSettings=assistant:changes")).toEqual({ category: "assistant", assistantTab: "changes" });
    expect(settingsLinkFromSearch("?openSettings=../x")).toBeNull();
    expect(settingsLinkFromSearch("?other=1")).toBeNull();
    expect(addressWithoutSettingsLink("http://h/p?openSettings=voice&a=1")).toBe("/p?a=1");
  });
});

describe("announcements and the new-features question", () => {
  it("announces voice, Assistant and design settings writes", () => {
    expect(settingsSectionOf("PUT", "/api/speech/voice-settings")).toBe("voice");
    expect(settingsSectionOf("PUT", "/api/assistant/settings")).toBe("assistant");
    expect(settingsSectionOf("PUT", "/api/settings/design")).toBe("design");
    expect(settingsSectionOf("POST", "/api/speech/transcribe")).toBeNull();
  });
  it("asks about the settings tools, off until chosen, decided in the Changes tab", () => {
    const intro = FEATURE_INTROS.find((i) => i.id === "assistant-settings-tools-2026-11");
    expect(intro?.setting).toBe("assistant_settings_tools");
    expect(featureIntroSettingsLink(intro!)).toMatchObject({ category: "assistant", assistantTab: "changes" });
  });
});
