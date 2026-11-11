/**
 * A project's Telegram detail level, digest switch and approved rules belong to the project, not to
 * the chat managing it: unsetting, deleting or replacing the manager chat keeps them, and the next
 * manager of the project starts with them. A card of a project with no setting at all reaches
 * Telegram with its title only.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import {
  deleteManagerChatRow, deleteManagerChatRowsFor, getManagerChatRow, patchManagerChatRow, projectTelegramDetail, putManagerChatRow,
} from "../../../src/services/assistant-managers/manager-chats-db.ts";
import { getManagerRules, setManagerRulesByUser } from "../../../src/services/assistant-managers/manager-rules-db.ts";

const KEY = "/p/tax";
const assign = (sessionId: string, projectKey = KEY) =>
  putManagerChatRow({ projectKey, projectPath: projectKey, sessionId, providerId: "claude", assignedBy: "user", assignedAt: 1 });

beforeEach(() => {
  getDb().run("DELETE FROM manager_chats");
  getDb().run("DELETE FROM manager_project_settings");
});

function configure(sessionId: string) {
  assign(sessionId);
  patchManagerChatRow(KEY, { telegramDetail: "title", digest: false });
  setManagerRulesByUser(KEY, "# Rules\nNever email the client.\n", 5);
}

describe("a project's manager settings", () => {
  it("survive unsetting the manager and come back with the next one", () => {
    configure("mgr-1");
    expect(deleteManagerChatRow(KEY)).toBe(true);
    expect(getManagerChatRow(KEY)).toBeNull();
    // While no chat manages it, its cards still go to Telegram as titles only.
    expect(projectTelegramDetail(KEY)).toBe("title");
    assign("mgr-2");
    expect(getManagerChatRow(KEY)).toMatchObject({ sessionId: "mgr-2", telegramDetail: "title", digest: false });
    expect(getManagerRules(KEY)).toMatchObject({ approved: "# Rules\nNever email the client.\n", accepted: "# Rules\nNever email the client.\n" });
  });

  it("survive the manager chat being deleted, or moved to another project", () => {
    configure("mgr-1");
    expect(deleteManagerChatRowsFor("mgr-1")).toEqual([KEY]);
    assign("mgr-1");
    expect(getManagerChatRow(KEY)?.telegramDetail).toBe("title");
    // The chat becomes another project's manager: this project keeps its settings for later.
    assign("mgr-1", "/p/other");
    expect(getManagerChatRow(KEY)).toBeNull();
    assign("mgr-3");
    expect(getManagerChatRow(KEY)?.telegramDetail).toBe("title");
    expect(getManagerRules(KEY)?.approved).toContain("Never email the client.");
  });

  it("are kept when another chat replaces the manager", () => {
    configure("mgr-1");
    assign("mgr-2");
    expect(getManagerChatRow(KEY)).toMatchObject({ sessionId: "mgr-2", telegramDetail: "title" });
  });

  it("are unknown for a project that never had a manager", () => {
    expect(projectTelegramDetail("/p/never")).toBeNull();
  });
});
