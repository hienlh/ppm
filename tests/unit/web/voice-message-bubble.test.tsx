/**
 * A sent voice message is drawn from the marker in its own text: what was typed above, then a
 * player and the transcript, with the marker line itself never shown and the recording fetched
 * only when it is played.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import { encodeVoicePart } from "../../../src/shared/voice-message";

installDom();
afterAll(uninstallDom);
const { UserBubble } = await import("../../../src/web/components/chat/message-user-bubble");
const { AttachmentChips } = await import("../../../src/web/components/chat/attachment-chips");

const voice = { path: "/home/u/.ppm/uploads/ab12-voice-20261120T120000.webm", durationSec: 42, transcript: "OK, sửa Hono middleware đi." };
let view: Mounted | null = null;

afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe("voice message bubble", () => {
  it("shows the typed text, then a player and the transcript, without the marker", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const content = `Lỗi lúc mở tab Git:\n\n${encodeVoicePart(voice)}`;
      view = await mount(<UserBubble content={content} timestamp="2026-11-20T12:00:00Z" projectName="ppm" />);
      const text = view.container.textContent ?? "";
      expect(text).toContain("Lỗi lúc mở tab Git:");
      expect(text).toContain("OK, sửa Hono middleware đi.");
      expect(text).toContain("0:42");
      expect(text).not.toContain("[Voice message");
      expect(view.container.querySelector("[data-voice-part] button[aria-label='Play voice message']")).not.toBeNull();
      // Nothing is downloaded until someone presses play.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("leaves a message with no voice part as it was", async () => {
    view = await mount(<UserBubble content="just text" timestamp="2026-11-20T12:00:00Z" projectName="ppm" />);
    expect(view.container.querySelector("[data-voice-part]")).toBeNull();
    expect(view.container.textContent).toContain("just text");
  });
});

describe("attachment row", () => {
  it("draws the voice chip beside the attachments, and alone when there are none", async () => {
    view = await mount(<AttachmentChips attachments={[]} onRemove={() => {}} extra={<span data-testid="voice">voice</span>} />);
    expect(view.container.querySelector("[data-testid='voice']")).not.toBeNull();
    await view.unmount();
    view = await mount(<AttachmentChips attachments={[]} onRemove={() => {}} />);
    expect(view.container.innerHTML).toBe("");
  });
});
