/**
 * The Undo and Open chat buttons PPM adds to the Assistant's task cards: an Undo only for a change
 * whose line the Telegram copy shows (#12 is not #120), and links put in the text only while the
 * card still fits one message.
 */
import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { cardForTelegram, taskCardRows } from "../../../../src/services/assistant-telegram/assistant-telegram-task-card-extras.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import { createTask } from "../../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { freshProject, PROJECT_PATH, USER } from "../ppm-tasks/ppm-tasks-fixture.ts";
import { ButtonCodes } from "../../../../src/services/assistant-telegram/assistant-telegram-button-codes.ts";
import type { BridgeAction } from "../../../../src/services/assistant-telegram/assistant-telegram-actions.ts";
import { telegramVisibleLength, TELEGRAM_CARD_ROOM } from "../../../../src/services/assistant-telegram/assistant-telegram-card-kinds.ts";

const codes = () => new ButtonCodes<BridgeAction>();
const texts = (rows: Array<Array<{ text: string }>>) => rows.flat().map((b) => b.text);

describe("task card buttons", () => {
  it("offers Undo only for a change the card's text shows, by its whole number", () => {
    const html = "- nxsys/2 \"Dọn log\": urgency · undo #120\n- …and 3 more";
    const { rows } = taskCardRows({ links: [], undos: [12, 120] }, "card-1", "1", html, codes());
    expect(texts(rows)).toEqual(["↶ Undo #120"]);
  });

  it("each Undo is a group of its own, standing for its history row", () => {
    const store = codes();
    const { rows } = taskCardRows({ links: [], undos: [7, 8] }, "card-1", "1", "undo #7 undo #8", store);
    const [first, second] = rows.flat();
    const taken = store.take(first!.callback_data, "1");
    expect(taken.ok && taken.action).toEqual({ kind: "task", ref: "card-1", op: "undo_history", historyId: 7 });
    expect(store.peek(second!.callback_data, "1").ok).toBe(true);
  });

  it("puts links in the text only while the card fits one message", () => {
    const body = "x".repeat(TELEGRAM_CARD_ROOM - 120);
    const inline = (n: number) => `Open chat · ppm/${n}: http://localhost:8080/project/ppm?openChat=claude/session-${n}`;
    const links = Array.from({ length: 8 }, (_, i) => ({ inline: inline(i) }));
    const out = taskCardRows({ links, undos: [] }, "card-1", "1", body, codes());
    expect(out.inline.length).toBeGreaterThan(0);
    expect(out.inline.length).toBeLessThan(8);
    expect(telegramVisibleLength([body, ...out.inline].join("\n"))).toBeLessThanOrEqual(TELEGRAM_CARD_ROOM);
  });

  it("makes URL buttons of links that can be buttons", () => {
    const out = taskCardRows({ links: [{ button: { text: "Open chat · ppm/1", url: "https://ppm.example.com/x" } }], undos: [] }, "c", "1", "", codes());
    expect(texts(out.rows)).toEqual(["Open chat · ppm/1"]);
    expect(out.inline).toEqual([]);
  });
});

describe("the while-you-were-away card on Telegram", () => {
  const setDetail = (projectKey: string, detail: "full" | "title") => getDb().query(
    "INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at, telegram_detail) VALUES (?, ?, 'mgr-1', 'claude', 'user', 1, ?)",
  ).run(projectKey, PROJECT_PATH, detail);

  function awayCard(detail: "full" | "title") {
    const f = freshProject();
    setDetail(f.projectKey, detail);
    const task = createTask({ projectKey: f.projectKey, title: "Payroll fix" }, USER);
    return {
      f,
      card: {
        body: "the hub's own text",
        payload: {
          taskChanges: [
            { historyId: 41, taskId: task.id, ref: "demo/1", summary: 'demo/1 "Payroll fix": notes changed to ACME salaries', projectKey: f.projectKey },
            { historyId: null, taskId: null, ref: null, summary: "demo settings: statuses changed", projectKey: f.projectKey },
          ],
          taskChangesMore: 3,
        },
      },
    };
  }

  it("lists each change in full, with the undo id its button is matched by", () => {
    const { card } = awayCard("full");
    expect(cardForTelegram(card).body.split("\n")).toEqual([
      "Made in a turn PPM started, not one you wrote in:",
      '- demo/1 "Payroll fix": notes changed to ACME salaries · undo #41',
      "- demo settings: statuses changed",
      "- …and 3 more (see each task's History in PPM)",
    ]);
  });

  it("shows only the ref and title for a title-only project, and offers no Undo", () => {
    const { card } = awayCard("title");
    const body = cardForTelegram(card).body;
    expect(body.split("\n").slice(1, 3)).toEqual([
      '- demo/1 "Payroll fix" (details in PPM)',
      "- A settings change in demo (details in PPM)",
    ]);
    expect(body).not.toContain("ACME");
    expect(taskCardRows({ links: [], undos: [41] }, "c", "1", body, codes()).rows).toEqual([]);
  });

  it("leaves every other card as it is", () => {
    const card = { body: "text", payload: {} };
    expect(cardForTelegram(card)).toBe(card);
  });
});
