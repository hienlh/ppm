import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";
import type { ReplyReference } from "../../../src/shared/chat-reply";
installDom();
afterAll(uninstallDom);
const { ReplyCard } = await import("../../../src/web/components/chat/reply-card");
const reply: ReplyReference = { version: 1, sessionId: "s", providerId: "codex", messageId: "m", role: "assistant", timestamp: "2026-10-01T10:00:00Z", quote: "first\nsecond\nthird", truncated: false };
describe("ReplyCard", () => {
  it("jumps to a resolved source and expands its snapshot", async () => {
    let jumps = 0;
    const view = await mount(<ReplyCard reply={reply} onJump={() => jumps++} />);
    try {
      const buttons = view.container.querySelectorAll("button");
      await click(buttons[0]!);
      expect(jumps).toBe(1);
      expect(view.container.querySelector("p")?.className).toContain("line-clamp-2");
      await click(buttons[1]!);
      expect(view.container.querySelector("p")?.className).toContain("overflow-y-auto");
      expect(view.container.textContent).toContain("third");
    } finally { await view.unmount(); }
  });
  it("keeps the unavailable snapshot and exposes cancel independently", async () => {
    let cancelled = 0;
    const view = await mount(<ReplyCard reply={reply} unavailable preview onCancel={() => cancelled++} />);
    try {
      expect(view.container.textContent).toContain("Original message unavailable");
      expect(view.container.textContent).toContain("Replying to AI");
      expect(view.container.querySelector("button")?.disabled).toBe(true);
      await click(view.container.querySelector('[aria-label="Cancel reply"]'));
      expect(cancelled).toBe(1);
      expect(view.container.textContent).toContain(reply.quote);
    } finally { await view.unmount(); }
  });
});
