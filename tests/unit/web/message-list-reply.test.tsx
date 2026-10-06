import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, installGlobal, mount, click } from "../../helpers/react-dom";
import { encodeReply, type ReplyReference } from "../../../src/shared/chat-reply";
import type { ChatMessage } from "../../../src/types/chat";
installDom();
afterAll(uninstallDom);
installGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
const { MessageList } = await import("../../../src/web/components/chat/message-list");
const timestamp = "2026-10-01T10:00:00Z";
const source: ChatMessage = { id: "u1", role: "user", content: "question", timestamp };
const reply: ReplyReference = { version: 1, sessionId: "s1", providerId: "codex", messageId: "u1", role: "user", quote: "question", timestamp, truncated: false };
describe("MessageList reply wiring", () => {
  it("passes selected user and assistant text to the composer callback", async () => {
    const selected: ReplyReference[] = [];
    const view = await mount(<MessageList messages={[source, { id: "a1", role: "assistant", content: "answer", timestamp }]} sessionId="s1" providerId="codex" pendingApproval={null} onApprovalResponse={() => {}} isStreaming={false} onReply={(value) => selected.push(value)} />);
    try {
      const buttons = view.container.querySelectorAll('[aria-label="Reply"]');
      expect(buttons.length).toBe(2);
      await click(buttons[0]!);
      await click(buttons[1]!);
      expect(selected.map(({ role, quote }) => ({ role, quote }))).toEqual([{ role: "user", quote: "question" }, { role: "assistant", quote: "answer" }]);
    } finally { await view.unmount(); }
  });
  it("navigates only a resolved quote source and highlights it", async () => {
    const view = await mount(<MessageList messages={[source, { id: "u2", role: "user", content: encodeReply("follow-up", reply), timestamp }]} sessionId="s1" providerId="codex" pendingApproval={null} onApprovalResponse={() => {}} isStreaming={false} />);
    try {
      const quote = [...view.container.querySelectorAll("button")].find((button) => button.textContent === "Reply to you");
      await click(quote ?? null);
      expect(view.container.querySelector('[data-msg-index="0"]')?.className).toContain("ring-primary/40");
      expect(view.container.textContent).not.toContain("Original message unavailable");
    } finally { await view.unmount(); }
  });
  it("replies to an earlier text segment when the last assistant segment is tool-only", async () => {
    const selected: ReplyReference[] = [];
    const messages: ChatMessage[] = [
      { id: "a-text", role: "assistant", content: "", timestamp, events: [{ type: "thinking", content: "private reasoning" }, { type: "text", content: "visible text before tool" }] },
      { id: "a-more", role: "assistant", content: "later text", timestamp },
      { id: "a-tool", role: "assistant", content: "", timestamp, events: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pwd" } }] },
      source,
    ];
    const view = await mount(<MessageList messages={messages} sessionId="s1" providerId="codex" pendingApproval={null} onApprovalResponse={() => {}} isStreaming={false} onReply={(value) => selected.push(value)} />);
    try {
      const buttons = view.container.querySelectorAll('[aria-label="Reply"]');
      expect(buttons.length).toBe(2);
      await click(buttons[0]!);
      expect(buttons[0]!.parentElement?.querySelector('[aria-label="Copy"]')).not.toBeNull();
      expect(selected[0]?.messageId).toBe("a-more");
      expect(selected[0]?.quote).toBe("later text");
      expect(selected[0]?.quote).not.toContain("private reasoning");
    } finally { await view.unmount(); }
  });

});
