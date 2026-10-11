/**
 * The PPM Assistant's picture of the screen travels inside the same `<ppm-shared-context>`
 * block as the project's shared instructions, so it must leave every place the block leaves:
 * reloaded history (Claude and Codex), the search index's reading of a transcript, and the
 * session titles taken from a first prompt.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinSharedContextEntries, stripSharedContext, withSharedContext } from "../../../src/shared/provider-context.ts";
import { decodeReply } from "../../../src/shared/chat-reply.ts";
import { renderUiSummary } from "../../../src/services/assistant/assistant-ui-summary.ts";
import { parseJsonlTranscript, parseSessionMessage } from "../../../src/services/jsonl-transcript-parser.ts";
import { parseRolloutJsonl } from "../../../src/providers/codex-app-server/codex-history.ts";
import { readRolloutHeader } from "../../../src/providers/codex-app-server/codex-rollout-header.ts";
import { createRolloutTailParser } from "../../../src/providers/codex-app-server/codex-rollout-tail-parser.ts";

const UI_ENTRY = renderUiSummary({
  project: "api",
  layout: "phone",
  panels: [{ area: "grid", focused: true, tabs: [{ type: "chat", title: "Secret plans", active: true }] }],
  windows: [],
});
const MESSAGE = "Fix the login";
const ui_only = withSharedContext(MESSAGE, joinSharedContextEntries(undefined, UI_ENTRY));
const both = withSharedContext(MESSAGE, joinSharedContextEntries("Project rules: be terse.", UI_ENTRY));

const dir = mkdtempSync(join(tmpdir(), "ppm-strip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const leaks = (text: string | undefined) => !!text && (text.includes("Secret plans") || text.includes("PPM screen"));

describe("the UI entry of the shared-context block", () => {
  it("is one block whatever entries it holds", () => {
    expect(joinSharedContextEntries(undefined, "  ")).toBeUndefined();
    expect(both.indexOf("<ppm-shared-context>")).toBe(0);
    expect(both.split("<ppm-shared-context>").length).toBe(2);
    expect(stripSharedContext(ui_only)).toBe(MESSAGE);
    expect(stripSharedContext(both)).toBe(MESSAGE);
  });

  it("stays out of a Claude session's title and reloaded messages", async () => {
    // The SDK's listing titles a session by its first prompt, read through this formula.
    expect(decodeReply(stripSharedContext(both)).content).toBe(MESSAGE);
    const record = { uuid: "u1", type: "user", timestamp: "2026-10-09T00:00:00Z", message: { role: "user", content: both } };
    expect(parseSessionMessage(record).content).toBe(MESSAGE);
    // What the search index reads.
    const file = join(dir, "claude.jsonl");
    writeFileSync(file, `${JSON.stringify(record)}\n${JSON.stringify({ ...record, uuid: "u2", message: { role: "user", content: ui_only } })}\n`);
    const messages = await parseJsonlTranscript(file);
    expect(messages.map((m) => m.content)).toEqual([MESSAGE, MESSAGE]);
    expect(messages.some((m) => leaks(m.content))).toBe(false);
  });

  it("stays out of a Codex session's history, title and live tail", () => {
    const text = [
      { type: "session_meta", payload: { id: "codex-ui", cwd: dir, cli_version: "0.100.0" } },
      { type: "event_msg", payload: { type: "user_message", message: both } },
      { type: "event_msg", payload: { type: "user_message", message: ui_only } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n";
    const history = parseRolloutJsonl(text);
    expect(history.filter((m) => m.role === "user").map((m) => m.content)).toEqual([MESSAGE, MESSAGE]);
    expect(readRolloutHeader(text, { withTitle: true })?.title).toBe(MESSAGE);
    const tail = createRolloutTailParser().feed(text);
    const texts = tail.events.map((e) => (e.ev as { content?: string }).content).filter(Boolean);
    expect(texts).toContain(MESSAGE);
    expect(texts.some((t) => leaks(t))).toBe(false);
  });
});
