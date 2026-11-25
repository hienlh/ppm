/**
 * Bookmarked turns and the Markdown export, browser side: the bubble's Bookmark button, the ···
 * menu's Bookmarks drill-in, and the file name an export is saved under.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { dispositionFileName } from "../../../src/web/lib/chat-export";
import { exportFileName } from "../../../src/services/session-turns/turn-markdown";
import { bookmarkLabelOf } from "../../../src/shared/session-bookmarks";

describe("export and label names", () => {
  it("names the file after the title, safely, and falls back to the session", () => {
    expect(exportFileName("Fix the login bug!", "abc")).toBe("fix-the-login-bug.md");
    expect(exportFileName("Sửa lỗi đăng nhập", "abc")).toBe("sửa-lỗi-đăng-nhập.md");
    expect(exportFileName("???", "0123456789")).toBe("chat-01234567.md");
  });

  it("reads the UTF-8 file name from Content-Disposition before the plain one", () => {
    expect(dispositionFileName("attachment; filename=\"s_a.md\"; filename*=UTF-8''s%E1%BB%ADa.md", "x.md")).toBe("sửa.md");
    expect(dispositionFileName("attachment; filename=\"plain.md\"", "x.md")).toBe("plain.md");
    expect(dispositionFileName(null, "x.md")).toBe("x.md");
  });

  it("labels a bookmark with the prompt's first non-empty line", () => {
    expect(bookmarkLabelOf("\n\n  Fix it \nmore")).toBe("Fix it");
    expect(bookmarkLabelOf("x".repeat(300)).length).toBe(200);
  });
});

installDom();
afterAll(uninstallDom);

const { api } = await import("../../../src/web/lib/api-client");
const { useSessionBookmarks } = await import("../../../src/web/stores/session-bookmarks-store");
const { useChatJumpStore } = await import("../../../src/web/stores/chat-jump-store");
const { BookmarkTurnButton } = await import("../../../src/web/components/chat/bookmark-turn-button");
const { BookmarksView } = await import("../../../src/web/components/chat/bookmarks-view");

const TURN = "55555555-0000-4000-8000-000000000001";
let view: Mounted | null = null;
let calls: Array<[string, string, unknown?]> = [];
let spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  calls = [];
  useSessionBookmarks.setState({ lists: {} });
  const echo = (list: unknown) => Promise.resolve(list as never);
  spies = [
    spyOn(api, "get").mockImplementation(((url: string) => { calls.push(["GET", url]); return echo([]); }) as never),
    spyOn(api, "put").mockImplementation(((url: string, body: unknown) => {
      calls.push(["PUT", url, body]);
      return echo([{ turnId: TURN, turnN: 1, label: (body as { label: string }).label, createdAt: "t" }]);
    }) as never),
    spyOn(api, "delete").mockImplementation(((url: string) => { calls.push(["DELETE", url]); return echo([]); }) as never),
  ];
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const s of spies) s.mockRestore();
});

const flush = () => import("react").then(({ act }) => act(async () => { await new Promise((r) => setTimeout(r, 0)); }));

describe("BookmarkTurnButton", () => {
  it("bookmarks the turn with the prompt's first line, then takes it off", async () => {
    view = await mount(createElement(BookmarkTurnButton, {
      message: { turnId: TURN, turnN: 1 }, text: "Fix the login bug\nplease", projectName: "proj", sessionId: "s1", providerId: "claude",
    }));
    await flush();
    const button = () => view!.container.querySelector("button")!;
    expect(button().textContent).toContain("Bookmark");

    await click(button());
    await flush();
    const put = calls.find((c) => c[0] === "PUT")!;
    expect(put[1]).toContain("/chat/sessions/s1/bookmarks/" + TURN);
    expect(put[2]).toEqual({ turnN: 1, label: "Fix the login bug" });
    expect(button().textContent).toContain("Bookmarked");

    await click(button());
    await flush();
    expect(calls.some((c) => c[0] === "DELETE" && c[1].endsWith("/bookmarks/" + TURN))).toBe(true);
    expect(button().textContent).not.toContain("Bookmarked");
  });
});

describe("BookmarksView", () => {
  it("jumps to a bookmarked turn and closes, and × removes one", async () => {
    useSessionBookmarks.setState({ lists: { ["proj\ns1"]: [{ turnId: TURN, turnN: 4, label: "Fix it", createdAt: "t" }] } });
    let jumped = 0;
    view = await mount(createElement(BookmarksView, { projectName: "proj", sessionId: "s1", onBack: () => {}, onJumped: () => { jumped++; } }));
    const row = view.container.querySelector("[data-bookmark-row]")!;
    expect(row.textContent).toContain("Fix it");
    expect(row.textContent).toContain("Turn 4");

    await click(row.querySelector("button")!);
    expect(jumped).toBe(1);
    expect(useChatJumpStore.getState().request).toMatchObject({ sessionId: "s1", turnId: TURN });

    await click(view.container.querySelector('[aria-label="Remove bookmark"]')!);
    await flush();
    expect(view.container.querySelector("[data-bookmark-row]")).toBeNull();
    expect(view.container.textContent).toContain("No bookmarks yet");
  });
});
