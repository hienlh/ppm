import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";

installDom();
const { act } = await import("react");
const { MarkdownRenderer } = await import("../../../src/web/components/shared/markdown-renderer");
const { UserBubble } = await import("../../../src/web/components/chat/message-user-bubble");
afterAll(uninstallDom);

/**
 * A `<task-notification>`'s result used to be rendered with rehype-raw, so an iframe srcdoc
 * inside it ran script in PPM's own origin (reproduced in Chromium: the frame read the auth
 * token from the parent's localStorage). System-tag content is now rendered as Markdown
 * with HTML shown as text.
 */
const SRCDOC = `<iframe id="pwn" srcdoc="&lt;script&gt;parent.document.title='pwned'&lt;/script&gt;"></iframe>`;

async function settle(times = 20) {
  for (let i = 0; i < times; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

describe("system-tag content renders no raw HTML", () => {
  it("still renders allowed HTML for ordinary Markdown, and never the iframe (the control)", async () => {
    const view = await mount(<MarkdownRenderer content={`Look: <kbd>Ctrl</kbd> ${SRCDOC}`} />);
    expect(view.container.querySelector("kbd")?.textContent).toBe("Ctrl");
    expect(view.container.querySelector("iframe")).toBeNull();
    await view.unmount();
  });

  it("renders HTML as text when rawHtml is off", async () => {
    const view = await mount(<MarkdownRenderer content={`Look: <kbd>Ctrl</kbd> ${SRCDOC} and **bold**`} rawHtml={false} />);
    expect(view.container.querySelector("kbd")).toBeNull();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.querySelector("strong")?.textContent).toBe("bold");
    expect(view.container.textContent).toContain("<iframe id=\"pwn\"");
    await view.unmount();
  });

  it("opens a task-notification result containing an iframe srcdoc without creating the iframe", async () => {
    const content = `<task-notification><status>completed</status><summary>Agent done</summary><result>Look: ${SRCDOC}</result></task-notification>`;
    const view = await mount(<UserBubble content={content} timestamp={new Date().toISOString()} />);
    const badge = [...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Agent done"));
    expect(badge).toBeDefined();
    await click(badge!);
    await settle();
    expect(view.container.textContent).toContain("Look:");
    expect(view.container.textContent).toContain("<iframe");
    expect(view.container.querySelector("iframe")).toBeNull();
    await view.unmount();
  });
});
