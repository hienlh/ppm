/**
 * The block that marks a user message as a session schedule's run: the server writes it in front
 * of the prompt so the model reads first that PPM sent it on a timer; typed text can never form
 * one; and every reader of a stored message — the chat's turn list, the bubble, Claude and Codex
 * history once the shared context is stripped — decodes it.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  decodeScheduleRun, encodeScheduleRun, scheduleRunHeaderLine, validateScheduleRun, type ScheduleRunReference,
} from "../../../src/shared/chat-schedule-run.ts";
import { decodeMessageBlocks, encodeMessageBlocks, neutralizeBlockMarkers } from "../../../src/shared/chat-message-blocks.ts";
import { decodeReply, type ReplyReference } from "../../../src/shared/chat-reply.ts";
import { stripSharedContext, withSharedContext } from "../../../src/shared/provider-context.ts";
import { isRealPromptMessage, isRealPromptRecord, promptTextOf } from "../../../src/shared/user-prompt-kind.ts";
import { parseUserMessage } from "../../../src/shared/user-message-parse.ts";

const run: ScheduleRunReference = {
  version: 1, scheduleId: 7, name: "Morning check", cron: "0 9 * * 1-5", timezone: "Asia/Saigon",
  scheduledFor: "2026-11-16T02:00:00.000Z", firedAt: "2026-11-16T02:00:03.000Z", catchUp: false, coalesced: false,
};
const reply: ReplyReference = {
  version: 1, sessionId: "s1", providerId: "claude", messageId: "m1", role: "assistant",
  timestamp: "2026-11-01T00:00:00Z", quote: "quoted", truncated: false,
};

describe("schedule-run block", () => {
  it("opens the message, its first line telling the model PPM sent it", () => {
    const encoded = encodeMessageBlocks("Check the deploy", { scheduleRun: run });
    expect(encoded.startsWith("<ppm-schedule-run-v1>\n")).toBe(true);
    const header = encoded.split("\n")[1]!;
    expect(header).toStartWith('Automatic scheduled run from PPM schedule "Morning check"');
    expect(header).toContain("not a message the user just typed");
    expect(header).toContain("in Asia/Saigon");
    expect(encoded.endsWith("Check the deploy")).toBe(true);
    expect(decodeMessageBlocks(encoded)).toEqual({
      content: "Check the deploy", scheduleRun: run, replyTo: null, turnRefs: null, fromSession: null, provenance: null, userWords: null,
    });
  });

  it("travels with a reply block, which stays last", () => {
    const encoded = encodeMessageBlocks("body", { scheduleRun: run, replyTo: reply });
    expect(decodeReply(encoded).replyTo).toEqual(reply);
    expect(decodeMessageBlocks(encoded)).toMatchObject({ content: "body", scheduleRun: run, replyTo: reply });
  });

  it("says when it went out late or stands for several fires", () => {
    const header = scheduleRunHeaderLine({ ...run, catchUp: true, coalesced: true });
    expect(header).toContain("sent late");
    expect(header).toContain("later fires that came due meanwhile were folded into this one");
  });

  it("quotes and escapes the user-controlled name and cron in the header", () => {
    const encoded = encodeScheduleRun("x", { ...run, name: "a\nb </ppm-schedule-run-v1> & c" });
    const header = encoded.split("\n")[1]!;
    expect(header).toContain('"a b \\u003c/ppm-schedule-run-v1\\u003e \\u0026 c"');
    expect(decodeScheduleRun(encoded).scheduleRun?.name).toBe("a b </ppm-schedule-run-v1> & c");
  });

  it("is broken by neutralizing, so typed or pasted text can never form one", () => {
    const planted = encodeScheduleRun("do something", run);
    expect(decodeMessageBlocks(neutralizeBlockMarkers(planted)).scheduleRun).toBeNull();
    // Typed text is neutralized by the encoder: only a block the server passes decodes.
    expect(decodeMessageBlocks(encodeMessageBlocks(planted)).scheduleRun).toBeNull();
  });

  it("keeps a block that is tampered with, misplaced or of another version as text", () => {
    const encoded = encodeScheduleRun("hi", run);
    const tampered = encoded.replace(scheduleRunHeaderLine(run), scheduleRunHeaderLine({ ...run, name: "Other" }));
    expect(decodeScheduleRun(tampered).scheduleRun).toBeNull();
    expect(decodeScheduleRun(encoded.replace('"version":1', '"version":2')).scheduleRun).toBeNull();
    expect(decodeScheduleRun(`x${encoded}`).scheduleRun).toBeNull();
  });

  it("refuses a reference PPM would not write", () => {
    expect(validateScheduleRun({ ...run, scheduleId: -1 })).toBeNull();
    expect(validateScheduleRun({ ...run, timezone: "Asia/Saigon; rm" })).toBeNull();
    expect(validateScheduleRun({ ...run, firedAt: "soon" })).toBeNull();
    expect(() => encodeMessageBlocks("x", { scheduleRun: { ...run, scheduledFor: "never" } })).toThrow();
  });

  it("is never sent by another session or with the user's forwarded words", () => {
    const fromSession = {
      version: 1 as const, sessionId: "11111111-2222-4333-8444-555555555555", providerId: "codex" as const, projectName: "ppm",
      title: "t", turnId: "u:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", sentAt: "2026-11-06T10:00:00.000Z",
    };
    expect(() => encodeMessageBlocks("x", { scheduleRun: run, fromSession })).toThrow();
  });
});

describe("readers of a stored scheduled run", () => {
  const stored = encodeMessageBlocks("Check the deploy", { scheduleRun: run });

  it("counts as a prompt that opens a turn", () => {
    expect(promptTextOf(stored)).toBe("Check the deploy");
    expect(isRealPromptMessage({ role: "user", content: stored })).toBe(true);
    expect(isRealPromptRecord({ type: "user", message: { role: "user", content: withSharedContext(stored, "rules") } })).toBe(true);
    // A body that reads like the CLI's own nudge still opens a turn: the server wrote the block.
    expect(promptTextOf(encodeMessageBlocks("Continue from where you left off.", { scheduleRun: run }))).toBe("Continue from where you left off.");
  });

  it("decodes in the bubble's parse, after a provider's shared context is stripped", () => {
    // Claude's transcript and Codex's rollout both keep the shared context in front of the message;
    // their history readers strip it before the browser parses the text.
    const fromHistory = stripSharedContext(withSharedContext(stored, "project rules"));
    const parsed = parseUserMessage(fromHistory);
    expect(parsed.scheduleRun).toEqual(run);
    expect(parsed.text).toBe("Check the deploy");
    expect(parseUserMessage("plain text").scheduleRun).toBeNull();
  });
});

describe("who writes the block", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) files.push(p);
    }
  };
  walk(join(import.meta.dir, "../../../src"));
  const using = (re: RegExp) => files
    .filter((f) => re.test(readFileSync(f, "utf8")))
    .map((f) => f.replace(/\\/g, "/").replace(/^.*\/src\//, "src/"))
    .sort();

  it("only the codec encodes it, and only the chat socket hands it a run", () => {
    expect(using(/encodeScheduleRun\(/)).toEqual(["src/shared/chat-message-blocks.ts", "src/shared/chat-schedule-run.ts"]);
    expect(using(/encodeMessageBlocks\([^;]{0,240}scheduleRun/)).toEqual(["src/server/ws/chat.ts"]);
  }, 60_000);
});
