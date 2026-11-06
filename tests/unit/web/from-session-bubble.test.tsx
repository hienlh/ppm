/**
 * A message another session's AI sent: drawn from its block with no request, unmistakably not the
 * person's (no Edit, Fork or Reply), its header opening the sender at the turn that sent it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { encodeMessageBlocks } from "../../../src/shared/chat-message-blocks";
import type { FromSessionReference } from "../../../src/shared/chat-from-session";

installDom();
afterAll(uninstallDom);
const { UserBubble } = await import("../../../src/web/components/chat/message-user-bubble");
const { api } = await import("../../../src/web/lib/api-client");
const { useChatJumpStore } = await import("../../../src/web/stores/chat-jump-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");

const from: FromSessionReference = {
  version: 1, sessionId: "aaaaaaaa-0000-4000-8000-000000000001", providerId: "codex", projectName: "ppm",
  title: "<b>Refactor</b> & tests", turnId: "bbbbbbbb-1111-4000-8000-000000000001", sentAt: "2026-11-06T10:00:00.000Z",
};
const content = encodeMessageBlocks("Done: **3 files** changed.", { fromSession: from });
let view: Mounted | null = null;
let get: ReturnType<typeof spyOn>;

beforeEach(() => {
  get = spyOn(api, "get").mockImplementation((() => Promise.resolve(null)) as never);
  useChatJumpStore.setState({ request: null, aliases: {} });
  useProjectStore.setState({ projects: [{ name: "ppm", path: "/p" }] as never, activeProject: { name: "ppm", path: "/p" } as never });
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  get.mockRestore();
});

describe("FromSessionBubble", () => {
  it("draws the sender from the block, as text, with no request", async () => {
    view = await mount(<UserBubble content={content} timestamp="2026-11-06T10:00:00Z" projectName="ppm" />);
    const bubble = view.container.querySelector(`[data-from-session="${from.sessionId}"]`)!;
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toContain("From:");
    expect(bubble.textContent).toContain("<b>Refactor</b> & tests");
    expect(bubble.textContent).toContain("Codex");
    expect(bubble.querySelector("b")).toBeNull();
    // The block itself is not text the reader sees, and the person's bubble is not drawn.
    expect(view.container.textContent).not.toContain("ppm-from-session-v1");
    expect(view.container.querySelector("[data-user-message]")).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("offers no Edit, Fork or Reply even when the list hands it those handlers", async () => {
    view = await mount(
      <UserBubble content={content} timestamp="2026-11-06T10:00:00Z" projectName="ppm"
        onEdit={() => {}} onFork={() => {}} onReply={() => {}} />,
    );
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("Edit");
    expect(text).not.toContain("Fork");
    expect(text).not.toContain("Reply");
    expect(text).toContain("Copy");
  });

  it("opens the sender at the turn that sent the message when the header is tapped", async () => {
    const openTab = spyOn(useTabStore.getState(), "openTab").mockImplementation(() => "tab");
    try {
      view = await mount(<UserBubble content={content} timestamp="2026-11-06T10:00:00Z" projectName="ppm" />);
      const header = view.container.querySelector(`[data-from-session] button`)!;
      expect(header.className).toContain("min-h-11");
      await click(header);
      expect(useChatJumpStore.getState().request).toMatchObject({ sessionId: from.sessionId, turnId: from.turnId });
      expect(openTab.mock.calls[0]![0]).toMatchObject({ type: "chat", metadata: { sessionId: from.sessionId, providerId: "codex", projectName: "ppm" } });
    } finally {
      openTab.mockRestore();
    }
  });

  it("keeps an ordinary message in the person's own bubble", async () => {
    view = await mount(<UserBubble content="hello" timestamp="2026-11-06T10:00:00Z" projectName="ppm" onEdit={() => {}} />);
    expect(view.container.querySelector("[data-from-session]")).toBeNull();
    expect(view.container.querySelector("[data-user-message]")).not.toBeNull();
  });
});
