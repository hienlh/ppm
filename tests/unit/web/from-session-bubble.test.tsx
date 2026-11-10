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

  describe("folding a long message", () => {
    // happy-dom lays nothing out, so a clamped body is made to report more content than it shows.
    const proto = window.HTMLElement.prototype;
    const before = {
      scrollHeight: Object.getOwnPropertyDescriptor(proto, "scrollHeight"),
      clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
    };
    const restore = () => {
      for (const key of ["scrollHeight", "clientHeight"] as const) {
        if (before[key]) Object.defineProperty(proto, key, before[key]!);
        else delete (proto as unknown as Record<string, unknown>)[key];
      }
    };
    const overflow = () => {
      Object.defineProperty(proto, "scrollHeight", {
        configurable: true,
        get(this: HTMLElement) { return this.getAttribute("data-message-clamp") === "collapsed" ? 400 : 40; },
      });
      Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 40 });
    };
    afterEach(restore);

    const long = encodeMessageBlocks(Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the report.`).join("\n\n"), { fromSession: from });
    const toggle = (root: Element) => [...root.querySelectorAll("button")].find((b) => /Show (more|less)/.test(b.textContent ?? ""));

    it("clamps a long message to two lines under a header that stays visible, and Show more / Show less toggles it", async () => {
      overflow();
      view = await mount(<UserBubble content={long} timestamp="2026-11-06T10:00:00Z" projectName="ppm" />);
      const bubble = view.container.querySelector(`[data-from-session="${from.sessionId}"]`)!;
      const body = bubble.querySelector("[data-message-clamp]")!;
      expect(body.getAttribute("data-message-clamp")).toBe("collapsed");
      expect(body.className).toContain("line-clamp-2");
      // The header is outside the clamp, so folding never hides who sent it.
      const header = bubble.querySelector("button")!;
      expect(header.textContent).toContain("From:");
      expect(body.contains(header)).toBe(false);

      const more = toggle(bubble)!;
      expect(more.textContent).toBe("Show more");
      expect(more.getAttribute("aria-expanded")).toBe("false");
      await click(more);
      expect(body.getAttribute("data-message-clamp")).toBe("expanded");
      expect(body.className).not.toContain("line-clamp-2");
      expect(toggle(bubble)!.textContent).toBe("Show less");
      expect(toggle(bubble)!.getAttribute("aria-expanded")).toBe("true");
      await click(toggle(bubble)!);
      expect(body.getAttribute("data-message-clamp")).toBe("collapsed");
      expect(toggle(bubble)!.textContent).toBe("Show more");
    });

    it("offers no toggle when the message fits in two lines", async () => {
      view = await mount(<UserBubble content={content} timestamp="2026-11-06T10:00:00Z" projectName="ppm" />);
      const bubble = view.container.querySelector(`[data-from-session="${from.sessionId}"]`)!;
      expect(bubble.querySelector("[data-message-clamp]")).not.toBeNull();
      expect(toggle(bubble)).toBeUndefined();
    });

    it("folds the same way as the person's own bubble", async () => {
      overflow();
      view = await mount(<UserBubble content={"A long note.\n".repeat(30)} timestamp="2026-11-06T10:00:00Z" projectName="ppm" />);
      const own = view.container.querySelector("[data-user-message]")!;
      expect(own.querySelector("[data-message-clamp]")!.className).toContain("line-clamp-2");
      await click(toggle(own)!);
      expect(own.querySelector("[data-message-clamp]")!.getAttribute("data-message-clamp")).toBe("expanded");
    });
  });

  it("says in one muted line how the Assistant's turn behind a manager message started", async () => {
    const assistant: FromSessionReference = { ...from, providerId: "claude", projectName: "__assistant__", title: "Ops", kind: "assistant" };
    const telegram = encodeMessageBlocks("What is the status of the release?", {
      fromSession: assistant, provenance: { startedBy: "user_telegram", untrusted: false, opening: "check the release" },
    });
    view = await mount(<UserBubble content={telegram} timestamp="2026-11-06T10:00:00Z" projectName="ppm" />);
    const line = view.container.querySelector("[data-provenance]")!;
    expect(line.textContent).toBe("Asked by PPM Assistant · started by you on Telegram");
    expect(line.className).toContain("text-text-subtle");
    expect(view.container.textContent).toContain("What is the status of the release?");
    expect(view.container.textContent).not.toContain("ppm-assistant-provenance-v1");
    await view.unmount();

    const report = encodeMessageBlocks("Any blockers?", {
      fromSession: assistant, provenance: { startedBy: "ppm", untrusted: true, reason: "news" },
    });
    view = await mount(<UserBubble content={report} timestamp="2026-11-06T10:00:00Z" projectName="ppm" />);
    expect(view.container.querySelector("[data-provenance]")!.textContent)
      .toBe("Asked by PPM Assistant · started by PPM on a report · other text in that turn");
  });

  it("keeps an ordinary message in the person's own bubble", async () => {
    view = await mount(<UserBubble content="hello" timestamp="2026-11-06T10:00:00Z" projectName="ppm" onEdit={() => {}} />);
    expect(view.container.querySelector("[data-from-session]")).toBeNull();
    expect(view.container.querySelector("[data-user-message]")).not.toBeNull();
  });
});
