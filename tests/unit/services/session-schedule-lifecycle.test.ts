/**
 * A session schedule lives and dies with its chat: it is refused for a chat that cannot take one
 * or already has as many as a chat may, follows a chat a provider renames, goes when the chat is
 * deleted, and can be turned back on once paused.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { openTestDb, setDb, setSessionMigratedTo } from "../../../src/services/db.service.ts";
import {
  countSessionSchedules, getSchedule, insertSchedule, setSessionSchedulePaused, setSessionSchedulePending,
} from "../../../src/services/scheduler-db.service.ts";
import { createChatLifecycle } from "../../../src/services/chat-control/chat-lifecycle.ts";
import {
  assertCanAddSessionSchedule, followRenamedChats, forgetSessionSchedulesOf, resumeSessionSchedule,
  sessionScheduleTargetIds, SessionScheduleRefusal,
} from "../../../src/services/session-schedules/session-schedule-lifecycle.ts";
import type { ScheduleTargetDeps } from "../../../src/services/session-schedules/session-schedule-target.ts";
import { MAX_SCHEDULES_PER_SESSION } from "../../../src/shared/session-schedule-input.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import type { AIProvider } from "../../../src/types/chat.ts";

const CHAT = "chat-life-1";

interface FakeChat { projectPath?: string; provider?: string; assistant?: boolean; design?: boolean }
let chats: Record<string, FakeChat>;
let migrated: Record<string, string>;

const deps: ScheduleTargetDeps = {
  canonical: (id) => migrated[id] ?? id,
  stored: (id, read) => read(id),
  isDesign: (id) => !!chats[id]?.design,
  isAssistant: (id) => !!chats[id]?.assistant,
  hasClaudeTranscript: () => false,
  projectByPath: (p) => (p === "/work/proj" ? { name: "proj", path: "/work/proj" } : null),
  projectPath: (id) => chats[id]?.projectPath ?? null,
  provider: (id) => chats[id]?.provider ?? null,
};

function schedule(target = CHAT, over: { recurring?: boolean } = {}): number {
  return insertSchedule({
    name: "remind", cron_expr: "0 9 * * *", provider_id: "claude", project_path: "/work/proj", prompt: "go",
    kind: "session", target_session_id: target, recurring: over.recurring ?? true,
  });
}

function refusal(fn: () => unknown): SessionScheduleRefusal {
  try { fn(); } catch (e) { if (e instanceof SessionScheduleRefusal) return e; throw e; }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  setDb(openTestDb());
  chats = { [CHAT]: { projectPath: "/work/proj", provider: "claude" } };
  migrated = {};
});

describe("assertCanAddSessionSchedule", () => {
  it("answers the chat's project and provider", () => {
    expect(assertCanAddSessionSchedule(CHAT, deps)).toEqual({
      sessionId: CHAT, projectName: "proj", projectPath: "/work/proj", providerId: "claude",
    });
  });

  it("answers the chat's current id after a rename", () => {
    migrated = { "old-chat-id": CHAT };
    expect(assertCanAddSessionSchedule("old-chat-id", deps).sessionId).toBe(CHAT);
  });

  it("refuses a PPM Assistant chat and a design session", () => {
    chats["assist-chat"] = { projectPath: "/work/proj", provider: "claude", assistant: true };
    chats["canvas-chat"] = { projectPath: "/work/proj", provider: "claude", design: true };
    expect(refusal(() => assertCanAddSessionSchedule("assist-chat", deps)).code).toBe("invalid_target");
    expect(refusal(() => assertCanAddSessionSchedule("canvas-chat", deps)).message).toContain("design session");
  });

  it("refuses a chat that is gone, outside a registered project, or on another provider", () => {
    chats["loose-chat"] = { projectPath: "/elsewhere", provider: "claude" };
    chats["other-chat"] = { projectPath: "/work/proj", provider: "cursor" };
    expect(refusal(() => assertCanAddSessionSchedule("missing-chat", deps)).message).toContain("no longer exists");
    expect(refusal(() => assertCanAddSessionSchedule("loose-chat", deps)).message).toContain("no longer registered");
    expect(refusal(() => assertCanAddSessionSchedule("other-chat", deps)).message).toContain("provider");
  });

  it(`refuses the ${MAX_SCHEDULES_PER_SESSION + 1}th schedule, counting those under an old id`, () => {
    setSessionMigratedTo("old-id", CHAT);
    schedule("old-id");
    for (let i = 1; i < MAX_SCHEDULES_PER_SESSION - 1; i++) schedule();
    expect(() => assertCanAddSessionSchedule(CHAT, deps)).not.toThrow();
    schedule();
    const e = refusal(() => assertCanAddSessionSchedule(CHAT, deps));
    expect(e.code).toBe("limit");
  });
});

describe("following the chat", () => {
  it("moves the chat's schedules to the id a provider renames it to", () => {
    const lifecycle = createChatLifecycle();
    const stop = followRenamedChats(lifecycle);
    const id = schedule("codex-first-id");
    lifecycle.emit("migrated", { oldSessionId: "codex-first-id", newSessionId: "codex-thread-id" });
    expect(getSchedule(id)!.target_session_id).toBe("codex-thread-id");
    stop();
    lifecycle.emit("migrated", { oldSessionId: "codex-thread-id", newSessionId: "after-stop" });
    expect(getSchedule(id)!.target_session_id).toBe("codex-thread-id");
  });

  it("forgets every schedule aimed at a deleted chat under any id it had", () => {
    setSessionMigratedTo("old-id", CHAT);
    schedule("old-id");
    schedule(CHAT);
    const other = schedule("another-chat");
    expect(forgetSessionSchedulesOf(sessionScheduleTargetIds("old-id", deps))).toBe(2);
    expect(countSessionSchedules(CHAT) + countSessionSchedules("old-id")).toBe(0);
    expect(getSchedule(other)).not.toBeNull();
  });
});

describe("chatService.deleteSession", () => {
  let refuse = false;
  const provider: AIProvider = {
    id: "stub-schedule-delete", name: "stub",
    async createSession() { return { id: "x", providerId: "stub-schedule-delete", title: "", createdAt: "" }; },
    async resumeSession() { return { id: "x", providerId: "stub-schedule-delete", title: "", createdAt: "" }; },
    async listSessions() { return []; },
    async deleteSession() { if (refuse) throw new Error("refused"); },
    async *sendMessage(sessionId: string) { yield { type: "done" as const, sessionId }; },
  };

  it("drops the chat's schedules once the provider has deleted it, and keeps them when it refuses", async () => {
    providerRegistry.register(provider);
    const id = schedule("deleted-chat");
    refuse = true;
    await expect(chatService.deleteSession("stub-schedule-delete", "deleted-chat")).rejects.toThrow("refused");
    expect(getSchedule(id)).not.toBeNull();
    refuse = false;
    await chatService.deleteSession("stub-schedule-delete", "deleted-chat");
    expect(getSchedule(id)).toBeNull();
  });
});

describe("resumeSessionSchedule", () => {
  it("clears the reason and counts the next fire from now", () => {
    const id = schedule();
    setSessionSchedulePending(id, new Date(Date.now() - 60_000).toISOString(), null);
    setSessionSchedulePaused(id, "The chat was gone.");
    const now = new Date();
    const after = resumeSessionSchedule(id, now, deps);
    expect(after.paused_reason).toBeNull();
    expect(after.pending_since).toBeNull();
    expect(Date.parse(after.next_fire_at!)).toBeGreaterThan(now.getTime());
  });

  it("refuses while the chat still cannot take it, and for a schedule that is not a session one", () => {
    const id = schedule("missing-chat");
    setSessionSchedulePaused(id, "The chat was gone.");
    expect(refusal(() => resumeSessionSchedule(id, new Date(), deps)).code).toBe("invalid_target");
    expect(getSchedule(id)!.paused_reason).toBe("The chat was gone.");
    expect(refusal(() => resumeSessionSchedule(99_999, new Date(), deps)).code).toBe("not_found");
  });
});
