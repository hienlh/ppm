/**
 * Turn chips, Copy turn link, Edit and Fork belong to prompts the person sent. A compaction
 * summary, a meta record or a task notification can carry a references block in its text (the CLI
 * writes it, quoting earlier context), but it references nothing and must not be drawn as if the
 * person had.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, installGlobal, mount, type Mounted } from "../../helpers/react-dom";
import { encodeMessageBlocks } from "../../../src/shared/chat-message-blocks";
import type { TurnReference } from "../../../src/shared/chat-turn-ref";
import type { ChatMessage } from "../../../src/types/chat";

installDom();
installGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
afterAll(uninstallDom);
const { MessageBubble } = await import("../../../src/web/components/chat/message-bubble");
const { parseSessionMessage } = await import("../../../src/services/jsonl-transcript-parser");

const ref: TurnReference = {
  version: 1, projectName: "ppm", providerId: "claude", sessionId: "aaaaaaaa-0000-4000-8000-000000000009",
  turnId: "bbbbbbbb-1111-4000-8000-000000000009", n: 4, title: "Earlier", prompt: "the ask", at: "2026-11-01T08:00:00.000Z",
};
const content = encodeMessageBlocks("This session is being continued from a previous conversation.", { turnRefs: [ref] });
const base: ChatMessage = { id: "m1", role: "user", content, timestamp: "2026-11-04T10:00:00Z", turnId: ref.turnId, sdkUuid: "m1" };
let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const bubble = (message: ChatMessage) => (
  <MessageBubble message={message} isStreaming={false} projectName="ppm" sessionId="s1" providerId="claude" onFork={() => {}} onEdit={() => {}} />
);
const labels = () => [...view!.container.querySelectorAll("button")].map((b) => `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`);

describe("a user message that is not a prompt", () => {
  it("draws the chips, the turn link, Edit and Fork on a real prompt", async () => {
    view = await mount(bubble(base));
    expect(view.container.querySelector("[data-turn-refs]")).not.toBeNull();
    expect(labels().some((l) => l.includes("Copy turn link"))).toBe(true);
    expect(labels().some((l) => /\bEdit\b/.test(l))).toBe(true);
  });

  for (const [what, message] of [
    ["a compaction summary", { ...base, compaction: { trigger: "auto", preTokens: 1000, postTokens: 100, savedTokens: 900 } }],
    ["a record the CLI flags as not the person's", { ...base, notPrompt: true }],
  ] as Array<[string, ChatMessage]>) {
    it(`draws none of them on ${what}`, async () => {
      view = await mount(bubble(message));
      expect(view.container.querySelector("[data-turn-refs]")).toBeNull();
      expect(labels().some((l) => /Copy turn link|\bEdit\b|\bFork\b/.test(l))).toBe(false);
    });
  }

  it("is flagged from the transcript record itself: meta, compaction summary, task notification", () => {
    const record = (extra: Record<string, unknown>) => parseSessionMessage({
      uuid: "u1", type: "user", timestamp: "2026-11-04T10:00:00Z", message: { role: "user", content: "text that reads like a prompt" }, ...extra,
    } as never);
    expect(record({}).notPrompt).toBeUndefined();
    expect(record({ isMeta: true }).notPrompt).toBe(true);
    expect(record({ isCompactSummary: true, isVisibleInTranscriptOnly: true }).notPrompt).toBe(true);
    expect(record({ origin: { kind: "task-notification" } }).notPrompt).toBe(true);
  });
});
