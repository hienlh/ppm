import { afterAll, expect, test } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";
import { mapCodexEvent } from "../../../src/providers/codex-app-server/codex-event-mapper";

installDom();
const { InterleavedEvents } = await import("../../../src/web/components/chat/message-events");
const { markdownRendererImport } = await import("../../../src/web/components/chat/message-markdown");
await markdownRendererImport;
afterAll(uninstallDom);

test("text streaming is labeled Responding and completion removes the status", async () => {
  const events = [{ type: "text" as const, content: "Finished answer." }];
  const streaming = await mount(<InterleavedEvents events={events} isStreaming />);
  try {
    expect(streaming.container.textContent).toContain("Responding...");
    expect(streaming.container.textContent).not.toContain("Thinking");
  } finally {
    await streaming.unmount();
  }
  const completed = await mount(<InterleavedEvents events={events} isStreaming={false} />);
  try {
    expect(completed.container.textContent).toContain("Finished answer.");
    expect(completed.container.textContent).not.toContain("Responding...");
  } finally {
    await completed.unmount();
  }
});

test("Codex summary sections render as separate bold paragraphs, with working collapse", async () => {
  const events = [
    { method: "item/reasoning/summaryPartAdded", params: { summaryIndex: 0 } },
    { method: "item/reasoning/summaryTextDelta", params: { delta: "**Evaluating local browser" } },
    { method: "item/reasoning/summaryTextDelta", params: { delta: " session access**" } },
    { method: "item/reasoning/summaryPartAdded", params: { summaryIndex: 1 } },
    { method: "item/reasoning/summaryTextDelta", params: { delta: "**Planning tab inspection**\n\n- Check `tabs`" } },
  ].flatMap((event) => mapCodexEvent(event, "test"));
  const view = await mount(<InterleavedEvents events={events} isStreaming />);
  try {
    expect(Array.from(view.container.querySelectorAll("p > strong"), (el) => el.textContent))
      .toEqual(["Evaluating local browser session access", "Planning tab inspection"]);
    expect(view.container.querySelector("li code")?.textContent).toBe("tabs");
    await click(view.container.querySelector("button"));
    expect(view.container.querySelector(".markdown-content")).toBeNull();
    await click(view.container.querySelector("button"));
    expect(view.container.querySelectorAll("p > strong").length).toBe(2);
  } finally {
    await view.unmount();
  }
});
