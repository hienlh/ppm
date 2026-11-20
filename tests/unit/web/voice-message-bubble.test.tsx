/**
 * A sent voice message is drawn from the marker in its own text: what was typed above, then a
 * player and the transcript, with the marker line itself never shown and the recording fetched
 * only when it is played.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { click, installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import { encodeVoicePart } from "../../../src/shared/voice-message";

installDom();
afterAll(uninstallDom);
const { UserBubble } = await import("../../../src/web/components/chat/message-user-bubble");
const { AttachmentChips } = await import("../../../src/web/components/chat/attachment-chips");
const { VoiceAudioPlayer } = await import("../../../src/web/components/chat/voice-audio-player");

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

  it("draws no player for a marker naming a file outside PPM's uploads", async () => {
    const content = encodeVoicePart({ ...voice, path: "/home/u/.ssh/id_ed25519" });
    view = await mount(<UserBubble content={content} timestamp="2026-11-20T12:00:00Z" projectName="ppm" />);
    expect(view.container.querySelector("[data-voice-part]")).toBeNull();
  });

  it("draws no player inside a system-context message that prints a marker", async () => {
    // The tag's body becomes a badge; what follows it is the message text, marker included.
    const content = `<task-notification>Task finished.</task-notification>\n${encodeVoicePart(voice)}`;
    view = await mount(<UserBubble content={content} timestamp="2026-11-20T12:00:00Z" projectName="ppm" />);
    expect(view.container.querySelector("[data-voice-part]")).toBeNull();
  });

  it("leaves a message with no voice part as it was", async () => {
    view = await mount(<UserBubble content="just text" timestamp="2026-11-20T12:00:00Z" projectName="ppm" />);
    expect(view.container.querySelector("[data-voice-part]")).toBeNull();
    expect(view.container.textContent).toContain("just text");
  });
});

describe("voice player", () => {
  it("tries again on the next press after the recording failed to load", async () => {
    let calls = 0;
    const loader = async () => { calls++; throw new Error("HTTP 503"); };
    view = await mount(<VoiceAudioPlayer src={loader} durationSec={5} />);
    const button = () => view!.container.querySelector("button");
    await click(button());
    expect(calls).toBe(1);
    expect(button()?.getAttribute("aria-label")).toBe("Recording unavailable, press to try again");
    expect(button()?.hasAttribute("disabled")).toBe(false);
    await click(button());
    expect(calls).toBe(2);
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
