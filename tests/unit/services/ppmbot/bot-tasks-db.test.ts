import { describe, it, expect, beforeEach } from "bun:test";
import {
  openTestDb,
  setDb,
  createBotTask,
  updateBotTaskStatus,
  markBotTaskReported,
  getBotTask,
  getRecentBotTasks,
  getRunningBotTasks,
} from "../../../../src/services/db.service.ts";

describe("bot_tasks DB operations", () => {
  beforeEach(() => {
    const testDb = openTestDb();
    setDb(testDb);
  });

  describe("createBotTask", () => {
    it("should create a task with correct fields", () => {
      createBotTask("task-1", "chat-100", "ppm", "/projects/ppm", "fix login bug");
      const task = getBotTask("task-1");
      expect(task).toBeTruthy();
      expect(task!.id).toBe("task-1");
      expect(task!.chatId).toBe("chat-100");
      expect(task!.projectName).toBe("ppm");
      expect(task!.projectPath).toBe("/projects/ppm");
      expect(task!.prompt).toBe("fix login bug");
      expect(task!.status).toBe("pending");
      expect(task!.timeoutMs).toBe(900000);
      expect(task!.reported).toBe(false);
      expect(task!.resultSummary).toBeNull();
      expect(task!.resultFull).toBeNull();
      expect(task!.sessionId).toBeNull();
      expect(task!.error).toBeNull();
    });

    it("should accept custom timeout", () => {
      createBotTask("task-2", "chat-100", "ppm", "/p", "task", 300000);
      const task = getBotTask("task-2");
      expect(task!.timeoutMs).toBe(300000);
    });
  });

  describe("updateBotTaskStatus", () => {
    it("should update status to running", () => {
      createBotTask("task-3", "chat-100", "ppm", "/p", "test");
      updateBotTaskStatus("task-3", "running");
      const task = getBotTask("task-3");
      expect(task!.status).toBe("running");
      expect(task!.startedAt).toBeTruthy();
    });

    it("should update status to completed with result", () => {
      createBotTask("task-4", "chat-100", "ppm", "/p", "test");
      updateBotTaskStatus("task-4", "completed", {
        sessionId: "sess-abc",
        resultSummary: "Done!",
        resultFull: "Full output text here",
      });
      const task = getBotTask("task-4");
      expect(task!.status).toBe("completed");
      expect(task!.sessionId).toBe("sess-abc");
      expect(task!.resultSummary).toBe("Done!");
      expect(task!.resultFull).toBe("Full output text here");
      expect(task!.completedAt).toBeTruthy();
    });

    it("should update status to failed with error", () => {
      createBotTask("task-5", "chat-100", "ppm", "/p", "test");
      updateBotTaskStatus("task-5", "failed", { error: "SDK crashed" });
      const task = getBotTask("task-5");
      expect(task!.status).toBe("failed");
      expect(task!.error).toBe("SDK crashed");
      expect(task!.completedAt).toBeTruthy();
    });

    it("should update status to timeout", () => {
      createBotTask("task-6", "chat-100", "ppm", "/p", "test");
      updateBotTaskStatus("task-6", "timeout");
      const task = getBotTask("task-6");
      expect(task!.status).toBe("timeout");
      expect(task!.completedAt).toBeTruthy();
    });
  });

  describe("markBotTaskReported", () => {
    it("should set reported flag to true", () => {
      createBotTask("task-7", "chat-100", "ppm", "/p", "test");
      expect(getBotTask("task-7")!.reported).toBe(false);
      markBotTaskReported("task-7");
      expect(getBotTask("task-7")!.reported).toBe(true);
    });
  });

  describe("getBotTask", () => {
    it("should return null for non-existent task", () => {
      expect(getBotTask("nonexistent")).toBeNull();
    });
  });

  describe("getRecentBotTasks", () => {
    it("should return tasks for the given chat", () => {
      createBotTask("task-a", "chat-100", "ppm", "/p", "first");
      createBotTask("task-b", "chat-100", "ppm", "/p", "second");
      const tasks = getRecentBotTasks("chat-100", 10);
      expect(tasks.length).toBe(2);
      // Both tasks returned for same chat
      const ids = tasks.map((t) => t.id);
      expect(ids).toContain("task-a");
      expect(ids).toContain("task-b");
    });

    it("should filter by chatId", () => {
      createBotTask("task-c", "chat-100", "ppm", "/p", "my task");
      createBotTask("task-d", "chat-200", "ppm", "/p", "other task");
      const tasks = getRecentBotTasks("chat-100", 10);
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.chatId).toBe("chat-100");
    });

    it("should respect limit", () => {
      for (let i = 0; i < 5; i++) {
        createBotTask(`task-lim-${i}`, "chat-100", "ppm", "/p", `task ${i}`);
      }
      expect(getRecentBotTasks("chat-100", 3).length).toBe(3);
    });
  });

  describe("getRunningBotTasks", () => {
    it("should return pending and running tasks", () => {
      createBotTask("task-p", "chat-100", "ppm", "/p", "pending");
      createBotTask("task-r", "chat-100", "ppm", "/p", "running");
      updateBotTaskStatus("task-r", "running");
      createBotTask("task-c", "chat-100", "ppm", "/p", "completed");
      updateBotTaskStatus("task-c", "completed");

      const running = getRunningBotTasks();
      expect(running.length).toBe(2);
      const statuses = running.map((t) => t.status);
      expect(statuses).toContain("pending");
      expect(statuses).toContain("running");
    });

    it("should return empty when no active tasks", () => {
      createBotTask("task-done", "chat-100", "ppm", "/p", "done");
      updateBotTaskStatus("task-done", "completed");
      expect(getRunningBotTasks().length).toBe(0);
    });
  });

  describe("migration v14", () => {
    it("should create bot_tasks table alongside existing tables", () => {
      // openTestDb runs all migrations — verify both old and new tables exist
      const { getDb } = require("../../../../src/services/db.service.ts");
      const db = getDb();
      const tables = db.query(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ).all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("bot_tasks");
      expect(tableNames).toContain("clawbot_sessions");
      expect(tableNames).toContain("clawbot_memories");
      expect(tableNames).toContain("clawbot_paired_chats");
    });
  });
});
