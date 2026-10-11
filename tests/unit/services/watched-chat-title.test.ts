/**
 * A watched chat is named the way `chats_attention` names it — the title given to it, else the one
 * PPM last saw — and keeps that name across a provider's rename, since Codex replaces a new chat's
 * id during its first turn while the title was stored under the first one.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { setSessionMigratedTo, setSessionTitle, setSessionUnread } from "../../../src/services/db.service.ts";
import { unnamedChat, watchedChatTitle } from "../../../src/services/assistant-watch/watched-chat-title.ts";

const id = () => crypto.randomUUID();

describe("watchedChatTitle", () => {
  it("prefers the given title over the one PPM last saw, and is null for a chat nothing names", () => {
    const s = id();
    expect(watchedChatTitle(s)).toBeNull();
    setSessionUnread(s, "done", "Seen title", "api");
    expect(watchedChatTitle(s)).toBe("Seen title");
    setSessionTitle(s, "Given title");
    expect(watchedChatTitle(s)).toBe("Given title");
  });

  it("follows a rename back to the title stored under the earlier id, and from it forward", () => {
    const draft = id();
    const thread = id();
    setSessionTitle(draft, "List the root folder");
    setSessionMigratedTo(draft, thread);
    expect(watchedChatTitle(thread)).toBe("List the root folder");
    expect(watchedChatTitle(draft)).toBe("List the root folder");
    // A title set after the rename is the newer word.
    setSessionTitle(thread, "Renamed by the user");
    expect(watchedChatTitle(draft)).toBe("Renamed by the user");
  });

  it("names an unnamed chat by its id", () => {
    expect(unnamedChat("01a127b8-0000-4000-8000-000000000000")).toBe("Session 01a127b8");
  });
});
