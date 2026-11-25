/**
 * The PPM Assistant fixing the voice word lists itself: taking a wrong learned word out
 * (`voice.learned.<project>`, the pane's Undo) or a pair being counted (`voice.learning.<project>`,
 * its "Don't learn"), through the real settings tools, the Voice pane's own route and the change
 * log — and putting either back with the log's Undo. The words are the ones the Assistant's own
 * lists held on 25/11/2026.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { configService } from "../../src/services/config.service.ts";
import { getAssistantSettings } from "../../src/services/assistant/assistant-settings.service.ts";
import { readVoiceSettings } from "../../src/services/voice-message/voice-settings.ts";
import { routeCallerFor, type ToolContext } from "../../src/services/assistant-mcp/assistant-tool-family.ts";
import type { ApprovalAsk, ApprovalVerdict } from "../../src/services/assistant-mcp/assistant-approval-broker.ts";
import { SETTINGS_TOOL_HANDLERS } from "../../src/services/assistant-settings-tools/settings-tools.ts";
import { listSettingChanges } from "../../src/services/assistant-settings-tools/settings-change-log.ts";
import { undoSettingChange } from "../../src/services/assistant-settings-tools/settings-apply.ts";
import { lookupSetting } from "../../src/services/assistant-settings-tools/settings-catalog.ts";
import { ASSISTANT_PROJECT_NAME } from "../../src/shared/assistant-project.ts";

const P = ASSISTANT_PROJECT_NAME;
const LEARNED = `voice.learned.${P}`;
const LEARNING = `voice.learning.${P}`;

const asked: ApprovalAsk[] = [];
const allowAuto = async (a: ApprovalAsk): Promise<ApprovalVerdict> => { asked.push(a); return { verdict: "approved", auto: true }; };
const ctx = (): ToolContext => ({ sessionId: "assistant-voice", ask: allowAuto, callRoute: routeCallerFor("settings"), provenanceAtCall: { startedBy: "user_telegram", untrusted: false } });
const json = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);
const set = (key: string, value: unknown) => SETTINGS_TOOL_HANDLERS.settings_set!(ctx(), { changes: [{ key, value }] }).then(json);
const undo = (id: number) => undoSettingChange(id, { callRoute: routeCallerFor("settings"), approval: "user", origin: "telegram", sessionId: null });
const own = () => readVoiceSettings().projects[P]!;
const read = async (key: string) => {
  const found = lookupSetting(key);
  if (found.kind !== "setting") throw new Error(`${key} is not in the catalog`);
  return found.entry.read();
};

let savedAssistant: unknown;
beforeEach(() => {
  asked.length = 0;
  savedAssistant = configService.get("assistant");
  configService.set("assistant", { ...getAssistantSettings(), settings_tools: true } as never);
  const at = new Date().toISOString();
  configService.set("voice_message", {
    enabled: true, self_learning: true, review_before_send: false, words: [],
    projects: {
      [P]: {
        words: [],
        learned: [
          { word: "bỏ 20", from: "mức reboot", at, source: "edit" },
          { word: "Zalo", from: "gia lô", at, source: "chat", hits: 3, kind: "term" },
        ],
        candidates: [
          { from: "philly", to: "release", hits: 1, at, source: "chat", chats: ["a693b78b@2026-11-25"] },
          { from: "bpm", to: "PPM", hits: 1, at },
          { from: "Bpm", to: "PPM", hits: 1, at, source: "chat", chats: ["a693b78b@2026-11-25"] },
        ],
      },
    },
  } as never);
});
afterEach(() => configService.set("assistant", savedAssistant as never));

describe("the catalog lists", () => {
  it("reads each list as the pane shows it, heard → meant", async () => {
    expect(await read(LEARNED)).toEqual(["mức reboot → bỏ 20", "gia lô → Zalo"]);
    expect(await read(LEARNING)).toEqual(["philly → release", "bpm → PPM", "Bpm → PPM"]);
  });
});

describe("taking a wrong learned word out", () => {
  it("is the pane's Undo, direct in Full mode, logged, and put back by the log's Undo", async () => {
    const r = await set(LEARNED, ["gia lô → Zalo"]);
    expect(r).toMatchObject({ outcome: "changed", approval: "full" });
    expect(asked[0]!.alwaysAsk).toBeUndefined();
    expect(own().learned.map((l) => l.word)).toEqual(["Zalo"]);
    expect(own().blocked).toMatchObject([{ word: "bỏ 20", from: "mức reboot", source: "edit" }]);
    expect(listSettingChanges({ limit: 1 })[0]).toMatchObject({ key: LEARNED, before: ["mức reboot → bỏ 20", "gia lô → Zalo"], after: ["gia lô → Zalo"] });

    const back = await undo(r.changes[0].changeId);
    expect(back.ok).toBe(true);
    expect(own().learned.map((l) => l.word).sort()).toEqual(["Zalo", "bỏ 20"]);
    expect(own().blocked ?? []).toEqual([]);
  });
});

describe("stopping a pair being learned", () => {
  it("is the pane's Don't learn, and the log's Undo puts it back to be counted where it left off", async () => {
    const r = await set(LEARNING, ["bpm → PPM", "Bpm → PPM"]);
    expect(r.outcome).toBe("changed");
    expect(own().candidates!.map((c) => c.to)).toEqual(["PPM", "PPM"]);
    expect(own().blocked).toMatchObject([{ word: "release", from: "philly", source: "chat" }]);

    expect((await undo(r.changes[0].changeId)).ok).toBe(true);
    expect(own().learned.map((l) => l.word)).not.toContain("release");
    expect(own().candidates).toContainEqual(expect.objectContaining({ from: "philly", to: "release", hits: 1, source: "chat" }));
  });
});

describe("what the lists refuse, before asking anyone", () => {
  it("takes out both pairs teaching one word or neither, and never adds a word", async () => {
    const half = await SETTINGS_TOOL_HANDLERS.settings_set!(ctx(), { changes: [{ key: LEARNING, value: ["philly → release", "Bpm → PPM"] }] });
    expect(JSON.stringify(half)).toContain("both teach \\\"PPM\\\"");
    const added = await SETTINGS_TOOL_HANDLERS.settings_set!(ctx(), { changes: [{ key: LEARNED, value: ["mức reboot → bỏ 20", "gia lô → Zalo", "BPM → PPM"] }] });
    expect(JSON.stringify(added)).toContain("cannot be put back");
    expect(asked).toEqual([]);
    expect(own().learned).toHaveLength(2);
    expect(own().candidates).toHaveLength(3);

    const both = await set(LEARNING, ["philly → release"]);
    expect(both.outcome).toBe("changed");
    expect(own().candidates!.map((c) => c.to)).toEqual(["release"]);
  });
});
