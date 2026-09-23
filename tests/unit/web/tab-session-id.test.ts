/**
 * `tabSessionId` is what makes a design tab count as "the tab this session is in". The
 * source scan pins the call sites: a `type === "chat"` check next to a session id is how a
 * design session looked unopened and got re-opened as a plain chat outside design mode.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tabSessionId } from "../../../src/web/lib/tab-session-id";

describe("tabSessionId", () => {
  it("answers for chat and design tabs", () => {
    expect(tabSessionId({ type: "chat", metadata: { sessionId: "s1" } })).toBe("s1");
    expect(tabSessionId({ type: "design", metadata: { sessionId: "s2", designSlug: "x" } })).toBe("s2");
  });

  it("answers nothing for other tabs, sessionless tabs and junk ids", () => {
    expect(tabSessionId({ type: "editor", metadata: { sessionId: "s3" } })).toBeUndefined();
    expect(tabSessionId({ type: "chat", metadata: {} })).toBeUndefined();
    expect(tabSessionId({ type: "chat", metadata: { sessionId: "" } })).toBeUndefined();
    expect(tabSessionId({ type: "chat", metadata: { sessionId: 42 } })).toBeUndefined();
    expect(tabSessionId(undefined)).toBeUndefined();
    expect(tabSessionId(null)).toBeUndefined();
  });
});

describe("session-to-tab lookups go through tabSessionId", () => {
  const WEB = resolve(import.meta.dir, "../../../src/web");
  const SITES = [
    "hooks/use-chat.ts",
    "components/layout/tab-bar.tsx",
    "components/layout/mobile-nav.tsx",
    "components/layout/mobile-tab-switcher-sheet.tsx",
    "stores/panel-store.ts",
  ];
  for (const site of SITES) {
    it(`${site} uses the helper and no chat-only session check`, () => {
      const src = readFileSync(resolve(WEB, site), "utf8");
      expect(src).toContain("tabSessionId(");
      // `tabDef.type === "chat"` asks what is being *opened*, which is fine; a lookup of an
      // existing tab's session by its type is what may not come back.
      expect(src).not.toMatch(/(?<!tabDef)\.type === "chat"[^\n]*sessionId/);
    });
  }
});
