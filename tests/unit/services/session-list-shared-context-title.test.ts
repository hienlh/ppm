/**
 * A session's title must never be PPM's `<ppm-shared-context>` block. Most providers strip it
 * from the opening prompt, but a title made elsewhere (Antigravity names a chat from the prompt
 * it was sent, block included, and cuts it short) reached the chat list as the block's first
 * words. The list drops the block, and the browser shows "Untitled" when nothing is left.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { listProjectSessions } from "../../../src/services/chat-session-queries.service.ts";
import { sessionTitleWithoutContext } from "../../../src/shared/provider-context.ts";
import type { AIProvider, SessionInfo } from "../../../src/types/chat.ts";

const PROVIDER = "stub-shared-context-titles";
const at = "2026-11-15T10:00:00.000Z";
const session = (id: string, title: string): SessionInfo => ({ id, providerId: PROVIDER, title, createdAt: at, updatedAt: at });

const provider: AIProvider = {
  id: PROVIDER, name: PROVIDER,
  async createSession() { return session("x", ""); },
  async resumeSession() { return session("x", ""); },
  async listSessions() {
    return [
      session("cut", "<ppm-shared-context> PPM provider sharing is enabled for this project. These are user-ma"),
      session("whole", "<ppm-shared-context>\nrules\n</ppm-shared-context>\n\nFix the login page"),
      session("plain", "Fix the login page"),
    ];
  },
  async deleteSession() {},
  async *sendMessage(sessionId: string) { yield { type: "done" as const, sessionId }; },
};

beforeAll(() => providerRegistry.register(provider));

describe("session list titles", () => {
  it("drops a shared-context block, whole or cut short", async () => {
    const { sessions } = await listProjectSessions("/tmp/ppm-title-test", { providerId: PROVIDER, limit: 50, offset: 0 });
    const titles = Object.fromEntries(sessions.map((s) => [s.id, s.title]));
    expect(titles).toEqual({ cut: "", whole: "Fix the login page", plain: "Fix the login page" });
  });

  it("leaves a title that only mentions the tag alone", () => {
    expect(sessionTitleWithoutContext("Why is <ppm-shared-context> in my title?")).toBe("Why is <ppm-shared-context> in my title?");
    expect(sessionTitleWithoutContext("  <ppm-shared-context>")).toBe("");
  });
});
