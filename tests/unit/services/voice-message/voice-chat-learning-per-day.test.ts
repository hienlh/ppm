/**
 * A chat counts once a day toward a pair, in the user's time zone. Most voice messages go to the
 * PPM Assistant, which is one chat for months: counted once for the chat's whole life, nothing it
 * read was ever learned (11 pairs stuck at 1 of 3 on 25/11/2026). The pairs here are the ones the
 * Assistant really wrote that day.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { createChatLifecycle, type ChatLifecycle } from "../../../../src/services/chat-control/chat-lifecycle.ts";
import { learnFromUnderstood, startVoiceChatLearning } from "../../../../src/services/voice-message/voice-chat-learning.ts";
import { chatReadingKey } from "../../../../src/services/voice-message/voice-learned-store.ts";
import { readVoiceSettings } from "../../../../src/services/voice-message/voice-settings.ts";
import { ASSISTANT_PROJECT_NAME } from "../../../../src/shared/assistant-project.ts";
import { encodeMessageBlocks } from "../../../../src/shared/chat-message-blocks.ts";
import { encodeVoicePart } from "../../../../src/shared/voice-message.ts";

const PROJECT = ASSISTANT_PROJECT_NAME;
const ASSISTANT_CHAT = "a693b78b-0000-4000-8000-000000000001";
const ZONE = "Asia/Saigon";
const at = (iso: string) => new Date(iso);
const candidates = () => readVoiceSettings().projects[PROJECT]?.candidates ?? [];
const learned = () => readVoiceSettings().projects[PROJECT]?.learned ?? [];

let savedAssistant: unknown;
beforeEach(() => {
  savedAssistant = configService.get("assistant");
  configService.set("voice_message", { enabled: true, self_learning: true, review_before_send: true, words: [], projects: {} });
  // The user's zone, as Settings → PPM Assistant stores it: the day is theirs, not the host's or UTC's.
  configService.set("assistant", { timezone: ZONE } as never);
});
// Other files in the run read the Assistant's settings: put the row back as it was.
afterEach(() => configService.set("assistant", (savedAssistant ?? {}) as never));

describe("chatReadingKey", () => {
  it("dates a reading by the user's day, not UTC's", () => {
    // 23:30 and 00:30 in Saigon are 16:30 and 17:30 UTC of the same UTC day.
    expect(chatReadingKey("c", at("2026-11-25T16:30:00Z"), ZONE)).toBe("c@2026-11-25");
    expect(chatReadingKey("c", at("2026-11-25T17:30:00Z"), ZONE)).toBe("c@2026-11-26");
    // With no zone given it reads the configured one.
    expect(chatReadingKey("c", at("2026-11-25T17:30:00Z"))).toBe("c@2026-11-26");
  });
});

describe("one chat, counted once a day", () => {
  it("does not learn from the same chat on the same day, however often it reads the pair", () => {
    // "gia lô" → Zalo, read three times on 25/11 (Saigon): morning, afternoon, late evening.
    const t = "nhắn qua gia lô cho chị Lan";
    for (const iso of ["2026-11-25T02:54:41Z", "2026-11-25T06:17:18Z", "2026-11-25T16:59:00Z"]) {
      learnFromUnderstood(PROJECT, t, [{ heard: "gia lô", meant: "Zalo" }], at(iso), ASSISTANT_CHAT);
    }
    expect(learned()).toEqual([]);
    expect(candidates()).toMatchObject([
      { from: "gia lô", to: "Zalo", hits: 1, source: "chat", chats: [`${ASSISTANT_CHAT}@2026-11-25`] },
    ]);
    expect(learnFromUnderstood(PROJECT, t, [{ heard: "gia lô", meant: "Zalo" }], at("2026-11-25T13:00:00Z"), ASSISTANT_CHAT))
      .toEqual([{ from: "gia lô", to: "Zalo", status: "skipped", reason: "same-chat", hits: 1 }]);
  });

  it("learns from the same chat on three different days", () => {
    const t = "anh mở bánh file trong Bpm nha";
    const read = (iso: string) => learnFromUnderstood(PROJECT, t, [{ heard: "Bpm", meant: "PPM" }, { heard: "bánh file", meant: "bank file" }], at(iso), ASSISTANT_CHAT);
    expect(read("2026-11-25T13:43:18Z")).toEqual([
      { from: "Bpm", to: "PPM", status: "learning", hits: 1 },
      { from: "bánh file", to: "bank file", status: "learning", hits: 1 },
    ]);
    // 00:30 on 26/11 in Saigon is already the next day.
    expect(read("2026-11-25T17:30:00Z")).toMatchObject([{ status: "learning", hits: 2 }, { status: "learning", hits: 2 }]);
    expect(learned()).toEqual([]);
    expect(read("2026-11-27T03:00:00Z")).toEqual([
      { from: "Bpm", to: "PPM", status: "learned", hits: 3 },
      { from: "bánh file", to: "bank file", status: "learned", hits: 3 },
    ]);
    expect(learned()).toMatchObject([
      { word: "PPM", from: "Bpm", source: "chat", hits: 3 },
      { word: "bank file", from: "bánh file", source: "chat", hits: 3 },
    ]);
    expect(candidates()).toEqual([]);
  });

  it("still learns from three chats on one day", () => {
    const t = "Spring 57 có gì mới";
    for (const chat of ["c1", "c2", "c3"]) learnFromUnderstood(PROJECT, t, [{ heard: "Spring 57", meant: "Sprint 57" }], at("2026-11-25T13:49:07Z"), chat);
    expect(learned()).toMatchObject([{ word: "Sprint 57", from: "Spring 57", source: "chat", hits: 3 }]);
  });
});

describe("candidates stored before readings had a day", () => {
  /** The row as 0.26.35 wrote it on 25/11: bare chat ids. */
  const storeOld = (from: string, to: string, chats: string[], atIso: string, hits = chats.length) => configService.set("voice_message", {
    enabled: true, self_learning: true, review_before_send: true, words: [],
    projects: { [PROJECT]: { words: [], learned: [], candidates: [{ from, to, hits, at: atIso, source: "chat", chats }] } },
  });

  it("reads a bare chat id as a reading on the day of the candidate's `at`", () => {
    storeOld("philly", "release", [ASSISTANT_CHAT], "2026-11-25T06:17:58.513Z");
    const t = "chuẩn bị philly bản mới";
    // Later the same day (Saigon): the old entry already counted this chat today.
    expect(learnFromUnderstood(PROJECT, t, [{ heard: "philly", meant: "release" }], at("2026-11-25T14:00:00Z"), ASSISTANT_CHAT))
      .toEqual([{ from: "philly", to: "release", status: "skipped", reason: "same-chat", hits: 1 }]);
    // The next day counts, and the old entry is kept, now dated.
    expect(learnFromUnderstood(PROJECT, t, [{ heard: "philly", meant: "release" }], at("2026-11-26T02:00:00Z"), ASSISTANT_CHAT))
      .toEqual([{ from: "philly", to: "release", status: "learning", hits: 2 }]);
    expect(candidates()).toMatchObject([
      { from: "philly", to: "release", hits: 2, chats: [`${ASSISTANT_CHAT}@2026-11-25`, `${ASSISTANT_CHAT}@2026-11-26`] },
    ]);
  });

  it("goes on counting an old pair two chats had read: a third chat learns it", () => {
    storeOld("tiết kiệm", "ticket", ["c1", "c2"], "2026-11-25T06:17:58.513Z");
    expect(learnFromUnderstood(PROJECT, "mở tiết kiệm mới", [{ heard: "tiết kiệm", meant: "ticket" }], at("2026-11-25T07:00:00Z"), "c3"))
      .toEqual([{ from: "tiết kiệm", to: "ticket", status: "learned", hits: 3 }]);
  });

  it("shows the old row in Settings unchanged until a new reading lands", () => {
    storeOld("startup", "status", [ASSISTANT_CHAT], "2026-11-25T06:20:22.437Z");
    expect(candidates()).toEqual([{ from: "startup", to: "status", hits: 1, at: "2026-11-25T06:20:22.437Z", source: "chat", chats: [ASSISTANT_CHAT] }]);
  });
});

describe("through the hook, in the Assistant", () => {
  let lifecycle: ChatLifecycle;
  let stop: () => void;
  let clock = 0;
  afterEach(() => stop());

  it("learns what the Assistant read on three days of one chat", () => {
    lifecycle = createChatLifecycle();
    stop = startVoiceChatLearning({ lifecycle, isAssistant: () => true, now: () => new Date(clock), defer: (work) => work() });
    const message = encodeMessageBlocks(
      encodeVoicePart({ path: "/x/uploads/a1-voice.webm", durationSec: 3, transcript: "nhắn gia lô cho chị Lan" }),
      { voiceHints: { version: 1, misheard: [], close: [] } },
    );
    const turn = (iso: string) => {
      clock = Date.parse(iso);
      lifecycle.emit("user_message", { sessionId: ASSISTANT_CHAT, text: message, origin: "telegram", imageCount: 0, projectName: PROJECT, providerId: "claude" } as never);
      lifecycle.emit("stream", { sessionId: ASSISTANT_CHAT, event: { type: "text", content: "**Hiểu là:** gia lô → Zalo\nEm nhắn rồi." } });
      lifecycle.emit("turn_ended", { sessionId: ASSISTANT_CHAT, outcome: "done", projectName: PROJECT, providerId: "claude" } as never);
    };
    turn("2026-11-25T02:54:41Z");
    turn("2026-11-25T13:43:00Z");
    expect(candidates()).toMatchObject([{ from: "gia lô", to: "Zalo", hits: 1 }]);
    turn("2026-11-26T02:00:00Z");
    turn("2026-11-27T02:00:00Z");
    expect(learned()).toMatchObject([{ word: "Zalo", from: "gia lô", source: "chat", hits: 3 }]);
  });
});
