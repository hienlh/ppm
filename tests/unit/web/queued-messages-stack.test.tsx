/**
 * The queue above the composer draws a queued message's attached images as the thumbnails the sent
 * bubble draws, never as the attachment markers' text.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";
import type { QueuedMessage } from "../../../src/shared/chat-queue";

installDom();
afterAll(uninstallDom);
const { QueuedMessagesStack } = await import("../../../src/web/components/chat/queued-messages-stack");

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const noop = () => {};
const queued = (content: string, imageCount = 0): QueuedMessage => ({ id: crypto.randomUUID(), content, imageCount, queuedAt: "2026-11-16T00:00:00Z" });

describe("QueuedMessagesStack", () => {
  it("shows an attached image as a thumbnail with its name, and the typed text beside it, not the marker", async () => {
    const content = "[Attached image (contents included in this message): /home/u/.ppm/uploads/1c5040cb-image.png]\n\nlook at this";
    view = await mount(<QueuedMessagesStack messages={[queued(content, 1)]} projectName="ppm" onSendNow={noop} onEdit={noop} onRemove={noop} />);
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("Attached image");
    expect(text).toContain("1c5040cb-image.png");
    expect(text).toContain("look at this");
    expect(view.container.querySelector("[data-image-gallery] button")).not.toBeNull();
    // Every image has a thumbnail, so no image count is shown, and an image alone is not "(no text)".
    expect(view.container.querySelector('[title="1 image"]')).toBeNull();
    await view.rerender(<QueuedMessagesStack messages={[queued(content.split("\n\n")[0]!, 1)]} onSendNow={noop} onEdit={noop} onRemove={noop} />);
    expect(view.container.textContent).not.toContain("(no text)");
  });

  it("names a plain attached file, and counts images that came with no path to draw", async () => {
    view = await mount(<QueuedMessagesStack messages={[queued("[Attached file: /p/notes.pdf]\n\nread it", 2)]} onSendNow={noop} onEdit={noop} onRemove={noop} />);
    const text = view.container.textContent ?? "";
    expect(text).toContain("notes.pdf");
    expect(text).not.toContain("Attached file");
    expect(view.container.querySelector('[title="2 images"]')).not.toBeNull();
  });

  it("says messages kept through a Stop wait for the person, not for the AI", async () => {
    view = await mount(<QueuedMessagesStack messages={[queued("one")]} onSendNow={noop} onEdit={noop} onRemove={noop} />);
    expect(view.container.textContent).toContain("1 queued · sent when the AI is ready");
    await view.rerender(<QueuedMessagesStack messages={[{ ...queued("one"), paused: true }]} onSendNow={noop} onEdit={noop} onRemove={noop} />);
    expect(view.container.textContent).toContain("1 held after Stop · sent only when you send them");
    await view.rerender(<QueuedMessagesStack messages={[{ ...queued("one"), paused: true }, queued("two")]} onSendNow={noop} onEdit={noop} onRemove={noop} />);
    expect(view.container.textContent).toContain("2 queued · 1 held after Stop");
  });
});
