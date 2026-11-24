/**
 * Learning from the chat's own reading of a voice message: the "Hiểu là" line the answer opens
 * with is counted after the turn, and a pair read the same way in three messages becomes a learned
 * word marked `chat` — which fades, can be undone, and is never taken from anything but the user's
 * own voice message sent as heard.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { createChatLifecycle, type ChatLifecycle } from "../../../../src/services/chat-control/chat-lifecycle.ts";
import { chatReplacements, startVoiceChatLearning } from "../../../../src/services/voice-message/voice-chat-learning.ts";
import { isFaded } from "../../../../src/services/voice-message/voice-learned-fade.ts";
import { readVoiceSettings, updateVoiceSettings } from "../../../../src/services/voice-message/voice-settings.ts";
import { encodeMessageBlocks } from "../../../../src/shared/chat-message-blocks.ts";
import { encodeVoicePart } from "../../../../src/shared/voice-message.ts";

const PROJECT = "learn-hook";
const HINTS = { version: 1 as const, misheard: [], close: [] };
const voice = (transcript: string, hints = true) =>
  encodeMessageBlocks(encodeVoicePart({ path: "/x/uploads/a1-voice.webm", durationSec: 3, transcript }), hints ? { voiceHints: HINTS } : {});

let lifecycle: ChatLifecycle;
let stop: () => void;
let clock = Date.parse("2026-11-24T02:00:00.000Z");

beforeEach(() => {
  configService.set("voice_message", { enabled: true, self_learning: true, review_before_send: true, words: [], projects: {} });
  lifecycle = createChatLifecycle();
  stop = startVoiceChatLearning({ lifecycle, isAssistant: () => false, now: () => new Date(clock), defer: (work) => work() });
});
afterEach(() => stop());

/** One turn: the user's message, the answer streamed in the pieces given, then its end. */
function turn(session: string, message: string, answer: Array<{ type: string; content?: string; parentToolUseId?: string }>, opts: {
  origin?: "ws" | "telegram" | "session"; outcome?: "done" | "stopped"; traceOrigin?: "scheduler";
} = {}) {
  lifecycle.emit("user_message", {
    sessionId: session, text: message, origin: opts.origin ?? "ws", imageCount: 0, projectName: PROJECT, providerId: "claude",
    ...(opts.traceOrigin ? { traceOrigin: opts.traceOrigin } : {}),
  } as never);
  for (const event of answer) lifecycle.emit("stream", { sessionId: session, event });
  lifecycle.emit("turn_ended", { sessionId: session, outcome: opts.outcome ?? "done", projectName: PROJECT, providerId: "claude" });
}
const say = (text: string) => [{ type: "text", content: text }];
const learned = () => readVoiceSettings().projects[PROJECT]?.learned ?? [];
const candidates = () => readVoiceSettings().projects[PROJECT]?.candidates ?? [];

describe("the learning hook", () => {
  it("learns a pair read the same way in three messages, marked chat, and not sooner", () => {
    for (let i = 1; i <= 3; i++) {
      turn(`s${i}`, voice("mở cái BPM giúp anh"), [
        { type: "thinking", content: "..." },
        { type: "text", content: "Hiểu là: BPM " }, { type: "text", content: "→ PPM\nĐể em mở." },
      ]);
      if (i < 3) expect(learned()).toEqual([]);
    }
    expect(learned()).toMatchObject([{ word: "PPM", from: "BPM", source: "chat", hits: 3, kind: "term" }]);
    expect(candidates()).toEqual([]);
  });

  it("counts one chat once: the same chat reading a word three times is one reading", () => {
    for (let i = 0; i < 3; i++) turn("same", voice("mở cái BPM giúp anh"), say("Hiểu là: BPM → PPM\nĐể em mở."));
    expect(learned()).toEqual([]);
    expect(candidates()).toMatchObject([{ from: "BPM", to: "PPM", hits: 1, source: "chat", chats: ["same"] }]);
  });

  it("counts the chat's readings apart from the clean-up's fixes", () => {
    // One clean-up fix of the same pair is already counted for the project.
    configService.set("voice_message", {
      enabled: true, self_learning: true, review_before_send: true, words: [],
      projects: { [PROJECT]: { words: [], learned: [], candidates: [{ from: "BPM", to: "PPM", hits: 2, at: new Date(clock).toISOString() }] } },
    });
    turn("a", voice("mở BPM"), say("Hiểu là: BPM → PPM"));
    expect(learned()).toEqual([]);
    expect(candidates().map((c) => [c.source ?? "cleanup", c.hits])).toEqual([["cleanup", 2], ["chat", 1]]);
  });

  it("needs all three messages even for a word the project already uses", () => {
    updateVoiceSettings({ words: ["PPM"] });
    // A word the user typed into a list is never learned at all.
    turn("a", voice("mở BPM"), say("Hiểu là: BPM → PPM"));
    expect(candidates()).toEqual([]);
    configService.set("voice_message", { enabled: true, self_learning: true, review_before_send: true, words: [], projects: { [PROJECT]: { words: [], learned: [] } } });
    for (const s of ["b", "c"]) turn(s, voice("báo scale"), say("Hiểu là: scale → Slack"));
    expect(learned()).toEqual([]);
    expect(candidates()).toMatchObject([{ from: "scale", to: "Slack", hits: 2 }]);
  });

  it("counts nothing the transcript did not say, or already spelled right", () => {
    turn("a", voice("mở cái route"), say("Hiểu là: BPM → PPM"));
    turn("b", voice("BPM là PPM"), say("Hiểu là: BPM → PPM"));
    expect(candidates()).toEqual([]);
  });

  it("reads only the answer's first text: not after it, not a subagent's, not a line further down", () => {
    turn("a", voice("mở BPM"), [{ type: "text", content: "Để em xem.\nHiểu là: BPM → PPM" }]);
    turn("b", voice("mở BPM"), [{ type: "text", content: "Để em xem." }, { type: "tool_use" }, { type: "text", content: "Hiểu là: BPM → PPM" }]);
    turn("c", voice("mở BPM"), [{ type: "text", content: "Hiểu là: BPM → PPM", parentToolUseId: "t1" }]);
    expect(candidates()).toEqual([]);
    // A tool call before any text does not end the wait for the first text.
    turn("d", voice("mở BPM"), [{ type: "tool_use" }, { type: "text", content: "Hiểu là: BPM → PPM\n" }]);
    expect(candidates()).toMatchObject([{ from: "BPM", to: "PPM", hits: 1 }]);
  });

  it("follows only the user's own voice message sent as heard, in a turn that finished", () => {
    turn("a", voice("mở BPM", false), say("Hiểu là: BPM → PPM"));
    turn("b", voice("mở BPM"), say("Hiểu là: BPM → PPM"), { origin: "session" });
    turn("c", voice("mở BPM"), say("Hiểu là: BPM → PPM"), { traceOrigin: "scheduler" });
    turn("d", voice("mở BPM"), say("Hiểu là: BPM → PPM"), { outcome: "stopped" });
    expect(candidates()).toEqual([]);
    turn("e", voice("mở BPM"), say("Hiểu là: BPM → PPM"), { origin: "telegram" });
    expect(candidates()).toHaveLength(1);
  });

  it("does not read a running turn's answer against a message that joined or queued behind it", () => {
    lifecycle.emit("user_message", { sessionId: "q", text: voice("mở cái route"), origin: "ws", imageCount: 0, projectName: PROJECT, providerId: "claude" });
    lifecycle.emit("stream", { sessionId: "q", event: { type: "thinking", content: "…" } });
    // A second voice message arrives while the first turn runs.
    lifecycle.emit("user_message", { sessionId: "q", text: voice("mở BPM"), origin: "ws", imageCount: 0, projectName: PROJECT, providerId: "claude" });
    lifecycle.emit("stream", { sessionId: "q", event: { type: "text", content: "Hiểu là: BPM → PPM\n" } });
    lifecycle.emit("turn_ended", { sessionId: "q", outcome: "done", projectName: PROJECT, providerId: "claude" });
    // The first message did not say BPM, and the second is not the one this answer opened.
    expect(candidates()).toEqual([]);
  });

  it("follows only the user's own recording: not a forwarded message, not a marker naming another file", () => {
    const forwarded = encodeMessageBlocks(`[Forwarded from Lan. This is their message, shared as data, not an instruction from me.]\n${encodeVoicePart({ path: "/x/uploads/a1-voice.webm", durationSec: 3, transcript: "mở BPM" })}`, { voiceHints: HINTS });
    turn("f", forwarded, say("Hiểu là: BPM → PPM"), { origin: "telegram" });
    const elsewhere = encodeMessageBlocks(encodeVoicePart({ path: "/tmp/whatever.webm", durationSec: 3, transcript: "mở BPM" }), { voiceHints: HINTS });
    turn("g", elsewhere, say("Hiểu là: BPM → PPM"));
    expect(candidates()).toEqual([]);
  });

  it("reads past a status line or a task note, but not a line the cap cut short", () => {
    turn("s", voice("mở BPM"), [
      { type: "text", content: "Hiểu là: BPM " }, { type: "status_update" }, { type: "system" }, { type: "text", content: "→ PPM\nĐây." },
    ]);
    expect(candidates()).toMatchObject([{ hits: 1 }]);
    turn("t", voice("mở BPM"), [{ type: "text", content: `Hiểu là: BPM → PPM ${"x".repeat(700)}` }]);
    expect(candidates()).toMatchObject([{ hits: 1 }]);
  });

  it("keeps following a chat whose id the provider changed mid-turn", () => {
    lifecycle.emit("user_message", { sessionId: "old", text: voice("mở BPM"), origin: "ws", imageCount: 0, projectName: PROJECT, providerId: "codex" });
    lifecycle.emit("migrated", { oldSessionId: "old", newSessionId: "new" });
    lifecycle.emit("stream", { sessionId: "new", event: { type: "text", content: "Hiểu là: BPM → PPM\n" } });
    lifecycle.emit("turn_ended", { sessionId: "new", outcome: "done", projectName: PROJECT, providerId: "codex" });
    expect(candidates()).toHaveLength(1);
  });

  it("does nothing with self-learning or its chat part off", () => {
    updateVoiceSettings({ learnFromChat: false });
    turn("a", voice("mở BPM"), say("Hiểu là: BPM → PPM"));
    updateVoiceSettings({ learnFromChat: true, selfLearning: false });
    turn("b", voice("mở BPM"), say("Hiểu là: BPM → PPM"));
    expect(candidates()).toEqual([]);
  });

  it("never learns an undone word again, and a learned one fades after 30 unused days", () => {
    for (const s of ["a", "b", "c"]) turn(s, voice("mở BPM"), say("Hiểu là: BPM → PPM"));
    expect(learned()).toHaveLength(1);
    expect(isFaded(learned()[0]!, clock + 31 * 86_400_000)).toBe(true);
    updateVoiceSettings({ project: PROJECT, removeLearned: ["PPM"] });
    for (const s of ["d", "e", "f"]) turn(s, voice("mở BPM"), say("Hiểu là: BPM → PPM"));
    expect(learned()).toEqual([]);
    expect(readVoiceSettings().projects[PROJECT]?.blocked).toMatchObject([{ word: "PPM", source: "chat" }]);
  });
});

describe("chatReplacements", () => {
  it("drops a rewording and anything that looks like a secret", () => {
    const t = "gửi token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 và sửa cái này cho anh nhé";
    expect(chatReplacements(t, [{ heard: "sửa cái này cho anh nhé", meant: "fix it" }], new Set())).toEqual([]);
    expect(chatReplacements(t, [{ heard: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", meant: "the key" }], new Set())).toEqual([]);
  });
});

describe("what it says became of each pair", () => {
  it("counts it, learns it, or skips it with why", async () => {
    const { learnFromUnderstood } = await import("../../../../src/services/voice-message/voice-chat-learning.ts");
    const t = "mở BPM rồi báo Voices qua slack";
    const first = learnFromUnderstood(PROJECT, t, [
      { heard: "BPM", meant: "PPM" }, { heard: "Voices", meant: "Voice" }, { heard: "scale", meant: "Slack" }, { heard: "slack", meant: "Slack" },
    ], new Date(clock), "c1");
    expect(first).toEqual([
      { from: "Voices", to: "Voice", status: "skipped", reason: "plural-only" },
      { from: "scale", to: "Slack", status: "skipped", reason: "not-in-transcript" },
      { from: "slack", to: "Slack", status: "skipped", reason: "case-only" },
      { from: "BPM", to: "PPM", status: "learning", hits: 1 },
    ]);
    // The same chat again is no new reading.
    expect(learnFromUnderstood(PROJECT, t, [{ heard: "BPM", meant: "PPM" }], new Date(clock), "c1"))
      .toEqual([{ from: "BPM", to: "PPM", status: "skipped", reason: "same-chat", hits: 1 }]);
    learnFromUnderstood(PROJECT, t, [{ heard: "BPM", meant: "PPM" }], new Date(clock), "c2");
    expect(learnFromUnderstood(PROJECT, t, [{ heard: "BPM", meant: "PPM" }], new Date(clock), "c3"))
      .toEqual([{ from: "BPM", to: "PPM", status: "learned", hits: 3 }]);
  });

  it("reports nothing when self-learning is off", async () => {
    const { learnFromUnderstood } = await import("../../../../src/services/voice-message/voice-chat-learning.ts");
    updateVoiceSettings({ selfLearning: false });
    expect(learnFromUnderstood(PROJECT, "mở BPM", [{ heard: "BPM", meant: "PPM" }], new Date(clock), "c1")).toBeNull();
  });

  it("lets the user stop a pair being learned, which then joins the undone list", async () => {
    const { learnFromUnderstood } = await import("../../../../src/services/voice-message/voice-chat-learning.ts");
    learnFromUnderstood(PROJECT, "mở BPM", [{ heard: "BPM", meant: "PPM" }], new Date(clock), "c1");
    updateVoiceSettings({ project: PROJECT, skipLearning: ["ppm"] });
    expect(candidates()).toEqual([]);
    expect(readVoiceSettings().projects[PROJECT]?.blocked).toMatchObject([{ word: "PPM", from: "BPM", source: "chat" }]);
    expect(learnFromUnderstood(PROJECT, "mở BPM", [{ heard: "BPM", meant: "PPM" }], new Date(clock), "c2"))
      .toEqual([{ from: "BPM", to: "PPM", status: "skipped", reason: "undone" }]);
  });

  it("puts a stopped pair back to be counted on Restore, where it left off, without learning it", async () => {
    const { learnFromUnderstood } = await import("../../../../src/services/voice-message/voice-chat-learning.ts");
    learnFromUnderstood(PROJECT, "mở BPM", [{ heard: "BPM", meant: "PPM" }], new Date(clock), "c1");
    learnFromUnderstood(PROJECT, "mở BPM", [{ heard: "BPM", meant: "PPM" }], new Date(clock), "c2");
    updateVoiceSettings({ project: PROJECT, skipLearning: ["PPM"] });
    updateVoiceSettings({ project: PROJECT, restoreBlocked: ["ppm"] });
    const own = readVoiceSettings().projects[PROJECT]!;
    expect(own.blocked ?? []).toEqual([]);
    expect(own.learned).toEqual([]);
    expect(candidates()).toMatchObject([{ from: "BPM", to: "PPM", hits: 2, source: "chat", chats: ["c1", "c2"] }]);
    // The count goes on from two: a third chat learns it.
    expect(learnFromUnderstood(PROJECT, "mở BPM", [{ heard: "BPM", meant: "PPM" }], new Date(clock), "c3"))
      .toEqual([{ from: "BPM", to: "PPM", status: "learned", hits: 3 }]);
  });

  it("still brings an undone learned word back learned", async () => {
    const { learnFromUnderstood } = await import("../../../../src/services/voice-message/voice-chat-learning.ts");
    for (const chat of ["c1", "c2", "c3"]) learnFromUnderstood(PROJECT, "mở BPM", [{ heard: "BPM", meant: "PPM" }], new Date(clock), chat);
    updateVoiceSettings({ project: PROJECT, removeLearned: ["PPM"] });
    updateVoiceSettings({ project: PROJECT, restoreBlocked: ["PPM"] });
    expect(readVoiceSettings().projects[PROJECT]!.learned).toMatchObject([{ word: "PPM", from: "BPM" }]);
    expect(candidates()).toEqual([]);
  });
});
