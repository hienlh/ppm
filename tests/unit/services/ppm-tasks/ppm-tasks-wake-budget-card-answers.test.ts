/**
 * The project's wake budget pauses once PPM has woken its manager chat as often as the pair limit
 * allows, until the user writes to that chat. Answering one of its cards is the user writing — the
 * words arrive as origin `session`, not `ws`, so they used to leave the pause in place: on 27/11
 * the ppm manager's twentieth wake since the user last typed in it went at 07:02, and every
 * finding after that became a card the manager could not place.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import { chatLifecycle } from "../../../../src/services/chat-control/chat-lifecycle.ts";
import { reserveManagerWake, userWroteToManager } from "../../../../src/services/ppm-tasks/ppm-tasks-wake-budget.ts";

const KEY = "wake-budget-card-answers";
const MANAGER = "mgr-wake-budget";
const savedAi = configService.get("ai");

beforeEach(() => {
  const ai = configService.get("ai");
  configService.set("ai", { ...ai, session_collab: { ...(ai.session_collab ?? {}), maxAutoMessagesPerPair: 1 } } as never);
  getDb().query("DELETE FROM manager_chats WHERE project_key = ?").run(KEY);
  getDb().query(
    "INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at) VALUES (?, '/p/wake', ?, 'claude', 'user', 1)",
  ).run(KEY, MANAGER);
  // The budget keeps its state in memory once read: start each test from the user having typed in
  // the manager chat, the way that has always lifted a pause.
  typed();
});

const typed = (origin: "ws" | "session" = "ws") =>
  chatLifecycle.emit("user_message", { sessionId: MANAGER, text: "hi", origin, imageCount: 0, projectName: "wake", providerId: "claude" });
afterAll(() => configService.set("ai", savedAi as never));

/** Uses up the pair limit of 1: the second wake pauses the project. */
function pauseProject(): void {
  expect(reserveManagerWake(MANAGER, KEY, false).ok).toBe(true);
  expect(reserveManagerWake(MANAGER, KEY, false).ok).toBe(false);
  expect(reserveManagerWake(MANAGER, KEY, false).ok).toBe(false);
}

describe("the wake budget's pause", () => {
  it("lifts when the user answers a card into the manager chat", () => {
    pauseProject();
    userWroteToManager(MANAGER);
    expect(reserveManagerWake(MANAGER, KEY, false).ok).toBe(true);
  });

  it("stays for words in a chat that manages nothing, and for a message another session sent", () => {
    pauseProject();
    userWroteToManager("some-child-chat");
    typed("session");
    expect(reserveManagerWake(MANAGER, KEY, false).ok).toBe(false);
  });

  it("still lifts when the user types in the manager chat", () => {
    pauseProject();
    typed();
    expect(reserveManagerWake(MANAGER, KEY, false).ok).toBe(true);
  });
});
