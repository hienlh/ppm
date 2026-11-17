/**
 * PPM Tasks on Telegram, end to end against a fake Bot API: `/tasks` (no AI turn), its status
 * buttons, "Tell manager now?", Undo, paging and the project filter; the card for a task the
 * Assistant created from a Telegram message; and the Undo / Open chat buttons PPM adds to the
 * Assistant's two task cards. The manager chat is scripted at the delivery door, so "Tell manager
 * now" is seen arriving there; the Assistant is a scripted Claude behind the real chat layer.
 *
 * "Message about this task" and a reply to a task card send the user's next words to the chat
 * working on the task (its handed-off chat, else the manager chat), through the real chat layer.
 *
 * Set `PPM_TG_TASKS_DUMP=<file>` to write every message the fake Telegram received to a file.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../test-setup.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerRegistry } from "../../src/providers/registry.ts";
import { configService } from "../../src/services/config.service.ts";
import { getDb, setSessionAssistant, setSessionMetadata, setSessionProvider, setSessionTitle, upsertApprovedPairing } from "../../src/services/db.service.ts";
import { setAssistantClock } from "../../src/services/assistant-wake/assistant-clock.ts";
import { assistantWakeQueue } from "../../src/services/assistant-wake/assistant-wake-queue.ts";
import { startAssistantCards, stopAssistantCards } from "../../src/services/assistant-cards/assistant-cards-startup.ts";
import { assistantCards } from "../../src/services/assistant-cards/assistant-cards.service.ts";
import { assistantTelegramBridge } from "../../src/services/assistant-telegram/assistant-telegram.service.ts";
import { bindChat } from "../../src/services/assistant-telegram/assistant-telegram-binding.ts";
import { BRIDGE_STATE_ROW } from "../../src/services/assistant-telegram/assistant-telegram-state.ts";
import { TELEGRAM_API_BASE_ENV } from "../../src/services/telegram/telegram-api-base.ts";
import { clearMainSessionIf, setMainSession } from "../../src/services/assistant/assistant-main-session.ts";
import { setPpmTasksDeliverEnv } from "../../src/services/ppm-tasks/ppm-tasks-deliver.ts";
import { createTask, getTask, updateTask } from "../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { taskHistory } from "../../src/services/ppm-tasks/ppm-tasks-history.ts";
import { addStatus, listStatuses } from "../../src/services/ppm-tasks/ppm-tasks-project-config.ts";
import { setTasksEnabled } from "../../src/services/ppm-tasks/ppm-tasks-projects.service.ts";
import { flushUnattendedChanges, noteUnattendedChange } from "../../src/services/ppm-tasks/ppm-task-unattended-card.ts";
import type { ChatControl } from "../../src/services/chat-control/chat-control.ts";
import { ASSISTANT_PROJECT_NAME } from "../../src/shared/assistant-project.ts";
import type { WriteContext } from "../../src/shared/ppm-tasks.ts";
import { startFakeTelegram, type FakeSentMessage } from "../helpers/fake-telegram-bot-api.ts";
import { FOLLOWUP_GRACE_MS } from "../../src/services/assistant-cards/card-reply-followup-tracker.ts";
import type { AIProvider, ChatEvent } from "../../src/types/chat.ts";
import type { PpmConfig } from "../../src/types/config.ts";

const fake = startFakeTelegram();
process.env[TELEGRAM_API_BASE_ENV] = fake.url;

const USER: WriteContext = { actor: { kind: "user", label: "You" }, via: "ppm" };
const home = process.env.PPM_HOME!;
const PHONE = 8_600_001;
const LINK = "https://ppm.example.com";

// ── The scripted Assistant: "nhớ …" creates a task in ppm, as its tool would from Telegram ──
let assistant = "";
const providerCalls: string[] = [];
let original: AIProvider | undefined;
const stub = {
  id: "claude", name: "Scripted Claude", supportsAssistantSessions: true, supportsSharedContext: true,
  async createSession() { return { id: crypto.randomUUID(), providerId: "claude", title: "", createdAt: "" }; },
  async resumeSession(id: string) { return { id, providerId: "claude", title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent> {
    providerCalls.push(message);
    if (message.includes("nhớ")) {
      createTask({ projectKey: keys.ppm, title: "Viết lại hướng dẫn cài đặt cho bản mới", urgency: "week" },
        { actor: { kind: "assistant", sessionId, label: "Assistant" }, via: "telegram", reason: "asked on Telegram" });
      yield { type: "text", content: "Created it in ppm." };
    } else {
      yield { type: "text", content: "Noted." };
    }
    yield { type: "done", sessionId };
  },
  hasStreamingSession() { return false; },
  pushMessage() {},
  resolveApproval() {},
  abortQuery() {},
} as unknown as AIProvider;

// ── The manager chats, scripted at the delivery door ──
const managerSends: Array<{ sessionId: string; text: string }> = [];
const fakeChat = {
  sendUserMessage: async (sessionId: string, text: string) => {
    managerSends.push({ sessionId, text });
    return { ok: true, sessionId, delivered: "started" };
  },
} as unknown as ChatControl;

// ── A clock the test moves ──
let clock = Date.UTC(2026, 10, 16, 7, 0, 0);
const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
const advance = (ms: number) => {
  clock += ms;
  for (const t of timers) if (t.live && t.at <= clock) { t.live = false; t.fn(); }
};

const keys = { nxsys: "", ppm: "", pex: "" };
const paths = { nxsys: join(home, "tg-tasks-nxsys"), ppm: join(home, "tg-tasks-ppm"), pex: join(home, "tg-tasks-pex") };
const ids: Record<string, string> = {};
let projectsBefore: PpmConfig["projects"] = [];
const clawbotBefore = configService.get("clawbot");
let notifySpy: ReturnType<typeof spyOn>;

const settle = () => assistantTelegramBridge.settle();
/** The newest `/tasks` deck, whatever it shows now (a card, a result, the children, the end). */
const deckMessage = (): FakeSentMessage => fake.sent(PHONE).findLast((m) => [m.text, ...m.history].some((t) => t.includes("What to do first")))!;
const buttonsOf = (m: FakeSentMessage) => (m.reply_markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
const button = (m: FakeSentMessage, text: string) => {
  const found = (m.reply_markup?.inline_keyboard ?? []).flat().find((b) => b.text === text);
  if (!found) throw new Error(`no button "${text}" in ${JSON.stringify(buttonsOf(m))}`);
  return found;
};
async function press(m: FakeSentMessage, text: string): Promise<string | undefined> {
  const before = fake.answers.length;
  fake.pressButton(PHONE, PHONE, m.message_id, button(m, text).callback_data!);
  await fake.waitFor(() => fake.answers.length > before);
  await settle();
  return fake.answers.at(-1)?.text;
}
async function send(text: string): Promise<void> {
  const before = fake.sent(PHONE).length;
  fake.pushText(PHONE, PHONE, text);
  await fake.waitFor(() => fake.sent(PHONE).length > before);
  await settle();
}
const statusId = (projectKey: string, name: string) => listStatuses(projectKey).find((s) => s.name === name)!.id;

beforeAll(async () => {
  getDb().query("DELETE FROM config WHERE key = ?").run(BRIDGE_STATE_ROW);
  getDb().query("DELETE FROM clawbot_paired_chats").run();
  upsertApprovedPairing(String(PHONE), String(PHONE), "Phone");
  for (const p of Object.values(paths)) mkdirSync(p, { recursive: true });
  projectsBefore = [...configService.get("projects")];
  configService.set("projects", [...projectsBefore, { name: "nxsys", path: paths.nxsys }, { name: "ppm", path: paths.ppm }, { name: "pex", path: paths.pex }]);
  configService.set("clawbot", { enabled: true, show_tool_calls: false, debounce_ms: 30 } as never);
  original = providerRegistry.get("claude");
  providerRegistry.register(stub);
  setAssistantClock({ now: () => clock, setTimer: (fn, ms) => { const t = { at: clock + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; } });
  setPpmTasksDeliverEnv({ chat: () => fakeChat, reserveWake: () => ({ ok: true, release: () => {} }) as never, now: () => clock });
  await import("../../src/server/ws/chat.ts");
  const { notificationService } = await import("../../src/services/notification.service.ts");
  notifySpy = spyOn(notificationService, "broadcast").mockImplementation(async () => {});

  for (const name of ["nxsys", "ppm", "pex"] as const) keys[name] = setTasksEnabled(paths[name], true, USER).projectKey;
  const insertManager = getDb().query("INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at, telegram_detail) VALUES (?, ?, ?, 'claude', 'user', 1, ?)");
  insertManager.run(keys.nxsys, paths.nxsys, "mgr-nxsys", "full");
  insertManager.run(keys.ppm, paths.ppm, "mgr-ppm", "title");
  for (const [id, p] of [["mgr-nxsys", "nxsys"], ["mgr-ppm", "ppm"], ["child-1", "nxsys"]] as const) {
    setSessionMetadata(id, p, paths[p]);
    setSessionProvider(id, "claude");
    setSessionTitle(id, id);
  }
  addStatus(keys.nxsys, { name: "In review", baseGroup: "active" }, USER);

  ids.psr = createTask({ projectKey: keys.nxsys, title: "PSR Ireland bỏ sót payslip", urgency: "now", importance: "must", statusId: statusId(keys.nxsys, "In progress"), nextStep: "fix period-13 filter" }, USER, clock).id;
  ids.pexNow = createTask({ projectKey: keys.pex, title: "Pex sprite sheet", urgency: "now", importance: "should" }, USER, clock).id;
  ids.ppmToday = createTask({ projectKey: keys.ppm, title: "Secret client payroll fix", urgency: "today", importance: "should", notes: "client ACME salaries" }, USER, clock).id;
  ids.nxLater = createTask({ projectKey: keys.nxsys, title: "Dọn log cũ", urgency: "later", importance: "nice" }, USER, clock).id;
  createTask({ projectKey: keys.nxsys, title: "Child A", parentId: ids.psr }, USER, clock);

  assistant = `asst-${crypto.randomUUID()}`;
  setSessionMetadata(assistant, ASSISTANT_PROJECT_NAME, join(home, "assistant-work"));
  setSessionProvider(assistant, "claude");
  setSessionAssistant(assistant);
  setMainSession(assistant);
  startAssistantCards();
  await assistantTelegramBridge.start({
    token: fake.token, client: { editIntervalMs: 0, sleep: async () => {} },
    debounceMs: 30, pollTimeoutS: 1, scaleDelay: (ms) => ms / 1000,
    sessionLink: async (p, id) => `${LINK}/assistant?session=${p}/${id}`,
    chatLink: async (project, p, id) => `${LINK}/project/${project}?openChat=${p}/${id}`,
    tasks: { taskLink: async (project, id) => `${LINK}/project/${project}?openTask=${id}` },
  });
  bindChat(String(PHONE), assistant);
});

afterAll(async () => {
  const dump = process.env.PPM_TG_TASKS_DUMP;
  if (dump) {
    const lines = fake.sent(PHONE).flatMap((m) => [
      `── message ${m.message_id}${m.history.length ? ` (edited ${m.history.length}×)` : ""}`,
      ...m.history.flatMap((h, i) => [`   · version ${i + 1}:`, ...h.split("\n").map((l) => `     ${l}`)]),
      ...(m.history.length ? ["   · now:"] : []),
      m.text,
      ...buttonsOf(m).map((row) => `  [ ${row.join(" ] [ ")} ]`),
    ]);
    writeFileSync(dump, [...lines, "", "── toasts", ...fake.answers.map((a) => `  ${a.text ?? ""}`)].join("\n"));
  }
  await assistantTelegramBridge.stop();
  stopAssistantCards();
  assistantWakeQueue.stop();
  clearMainSessionIf(assistant);
  setPpmTasksDeliverEnv(null);
  getDb().query("DELETE FROM clawbot_paired_chats WHERE telegram_chat_id = ?").run(String(PHONE));
  configService.set("clawbot", clawbotBefore!);
  configService.set("projects", projectsBefore);
  setAssistantClock(null);
  notifySpy?.mockRestore();
  if (original) providerRegistry.register(original);
  fake.stop();
  delete process.env[TELEGRAM_API_BASE_ENV];
});

describe("/tasks", () => {
  it("is in the bot's commands and its help", async () => {
    await fake.waitFor(() => fake.commands.length > 0);
    expect(fake.commands.map((c) => c.command)).toContain("tasks");
    await send("/help");
    expect(fake.lastText(PHONE)).toContain("/tasks");
  });

  it("deals the open tasks of every project with Tasks on, in what-to-do-first order, with no AI turn", async () => {
    await send("/tasks");
    const deck = deckMessage();
    expect(deck.text.split("\n").slice(0, 3)).toEqual(["1 of 5 · What to do first", "nxsys/1 PSR Ireland bỏ sót payslip", "nxsys · Now · Must · In progress"]);
    expect(deck.text).toContain("Next: fix period-13 filter");
    expect(providerCalls).toEqual([]);
    // The project's own statuses, its added one too, without the current one, closed-as-done last.
    expect(buttonsOf(deck)).toEqual([
      ["To do", "Waiting", "Dropped"], ["In review", "Done"],
      ["💬 Message about this task"],
      ["‹", "1 / 5", "›"],
      ["● All", "nxsys", "pex", "ppm"],
    ]);
  });

  it("pages with ‹ › and keeps a title-only project's details off the phone", async () => {
    let deck = deckMessage();
    await press(deck, "›");
    deck = deckMessage();
    expect(deck.text).toContain("2 of 5");
    expect(deck.text).toContain("Pex sprite sheet");
    await press(deck, "›");
    deck = deckMessage();
    expect(deck.text.split("\n").slice(1)).toEqual([expect.stringMatching(/^ppm\/\d+ Secret client payroll fix$/), "ppm · Today"]);
    expect(deck.text).not.toContain("Should");
    await press(deck, "‹");
    await press(deckMessage(), "‹");
    await press(deckMessage(), "‹");
    expect(deckMessage().text).toContain("5 of 5");
    expect(deckMessage().text).toContain("Dọn log cũ");
    expect(providerCalls).toEqual([]);
  });

  it("filters to one project", async () => {
    await press(deckMessage(), "pex");
    const deck = deckMessage();
    expect(deck.text).toContain("1 of 1");
    expect(buttonsOf(deck).at(-1)).toEqual(["All", "nxsys", "● pex", "ppm"]);
    await press(deck, "All");
    expect(deckMessage().text).toContain("1 of 5");
  });

  it("a status press in a project with a manager asks to tell it, and moves on only once answered", async () => {
    const deck = deckMessage();
    expect(deck.text).toContain("PSR Ireland");
    const toast = await press(deck, "Done");
    expect(toast).toBe("Marked Done");
    const result = deckMessage();
    expect(result.message_id).toBe(deck.message_id);
    expect(result.text).toContain("Status: In progress → Done");
    expect(result.text).toContain("By you from Telegram, 07:00. 1 child task is still open.");
    expect(buttonsOf(result)).toEqual([["↶ Undo"], ["Tell manager now", "Next turn"], ["Show open children (1)"]]);
    const last = taskHistory(ids.psr)[0]!;
    expect(last.actor.kind).toBe("user");
    expect(last.via).toBe("telegram");
    expect(getTask(ids.psr)!.baseGroup).toBe("closed");

    advance(5000);
    await settle();
    expect(deckMessage().text).toContain("Status: In progress → Done");

    await press(result, "Show open children (1)");
    expect(deckMessage().text).toContain("Open child tasks of nxsys/1 PSR Ireland bỏ sót payslip");
    await press(deckMessage(), "‹ Back");

    expect(await press(deckMessage(), "Tell manager now")).toBe("Sent to the nxsys manager");
    expect(managerSends.filter((s) => s.sessionId === "mgr-nxsys")).toHaveLength(1);
    expect(managerSends[0]!.text).toContain("PSR Ireland");
    expect(deckMessage().text).toContain("Sent to the nxsys manager.");
    expect(buttonsOf(deckMessage())[0]).toEqual(["↶ Undo", "Next task ›"]);

    advance(2000);
    await settle();
    const next = deckMessage();
    expect(next.text).toContain("Pex sprite sheet");
    expect(buttonsOf(next)[0]).toEqual(["↶ Undo: PSR Ireland bỏ sót payslip"]);
  });

  it("Undo puts the status back, as the user", async () => {
    expect(await press(deckMessage(), "↶ Undo: PSR Ireland bỏ sót payslip")).toBe("Undone");
    expect(getTask(ids.psr)!.statusId).toBe(statusId(keys.nxsys, "In progress"));
    expect(deckMessage().text).toContain("PSR Ireland bỏ sót payslip");
    expect(taskHistory(ids.psr)[0]!.reason).toBe("Undo from Telegram");
  });

  it("asks about the manager once per task in a deck", async () => {
    await press(deckMessage(), "Waiting");
    expect(buttonsOf(deckMessage())[0]).toEqual(["↶ Undo", "Next task ›"]);
    await press(deckMessage(), "↶ Undo");
  });

  it("Next turn tells nobody now", async () => {
    for (let i = 0; i < 4; i++) await press(deckMessage(), "›");
    expect(deckMessage().text).toContain("Dọn log cũ");
    const before = managerSends.length;
    await press(deckMessage(), "Waiting");
    expect(await press(deckMessage(), "Next turn")).toBe("The nxsys manager will see it on its next turn");
    expect(managerSends).toHaveLength(before);
    expect(deckMessage().text).toContain("The nxsys manager will see it on its next turn.");
    await press(deckMessage(), "↶ Undo");
  });

  it("a project with no manager just moves on after two seconds", async () => {
    await press(deckMessage(), "pex");
    await press(deckMessage(), "In progress");
    expect(buttonsOf(deckMessage())[0]).toEqual(["↶ Undo", "Next task ›"]);
    advance(2000);
    await settle();
    expect(deckMessage().text).toContain("That was the last one.");
    await press(deckMessage(), "↶ Undo: Pex sprite sheet");
    expect(getTask(ids.pexNow)!.baseGroup).toBe("not_started");
    await press(deckMessage(), "All");
  });

  it("refuses to overwrite a change made elsewhere since the card was drawn", async () => {
    await send("/tasks nxsys");
    const deck = deckMessage();
    expect(deck.text).toContain("1 of 3");
    const task = getTask(ids.psr)!;
    updateTask(ids.psr, { statusId: statusId(keys.nxsys, "Waiting") }, task.revision, USER);
    expect(await press(deck, "Done")).toBe("Changed elsewhere");
    expect(deckMessage().text).toContain("Changed elsewhere — here is the current state.");
    expect(deckMessage().text).toContain("nxsys · Now · Must · Waiting");
    expect(getTask(ids.psr)!.statusId).toBe(statusId(keys.nxsys, "Waiting"));
  });

  it("an old keyboard's buttons are no longer valid", async () => {
    const deck = deckMessage();
    const stale = deck.history.length;
    expect(stale).toBeGreaterThan(0);
    const before = fake.answers.length;
    // The first card's "Done" was replaced by a fresh group when the card was redrawn.
    const old = fake.calls.filter((c) => c.method === "sendMessage").at(-1)!;
    const oldData = ((old.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard
      .flat().find((b) => b.text === "Done"))!.callback_data!;
    fake.pressButton(PHONE, PHONE, deck.message_id, oldData, { stale: true });
    await fake.waitFor(() => fake.answers.length > before);
    expect(fake.answers.at(-1)!.text).toBe("This button is no longer valid.");
    expect(getTask(ids.psr)!.statusId).toBe(statusId(keys.nxsys, "Waiting"));
  });

  it("sends nothing for task changes made elsewhere", async () => {
    await settle();
    const before = fake.sent(PHONE).length;
    const task = getTask(ids.nxLater)!;
    updateTask(ids.nxLater, { importance: "must" }, task.revision, USER);
    createTask({ projectKey: keys.nxsys, title: "Made in PPM" }, USER, clock);
    await Bun.sleep(50);
    await settle();
    expect(fake.sent(PHONE).length).toBe(before);
  });

  it("names the projects to pick from when the one asked has no Tasks", async () => {
    await send("/tasks nope");
    expect(fake.lastText(PHONE)).toBe('No project called "nope" has Tasks on. Try: nxsys, pex, ppm.');
  });
});

describe("a task the Assistant created from Telegram", () => {
  it("comes back as one card with edit buttons, saying what the manager was told", async () => {
    const before = fake.sent(PHONE).length;
    fake.pushText(PHONE, PHONE, "nhớ viết lại phần hướng dẫn cài đặt cho bản mới");
    const card = await fake.waitFor(() => fake.sent(PHONE).slice(before).find((m) => m.text.startsWith("Created in")));
    await settle();
    expect(providerCalls.at(-1)).toContain("nhớ");
    const cards = fake.sent(PHONE).slice(before).filter((m) => m.text.startsWith("Created in"));
    expect(cards).toHaveLength(1);
    // ppm shows titles only on the phone.
    expect(card.text.split("\n")).toEqual([
      "Created in ppm",
      expect.stringMatching(/^ppm\/\d+ Viết lại hướng dẫn cài đặt cho bản mới$/),
      "ppm · This week",
      "The ppm manager will see it on its next turn.",
    ]);
    expect(buttonsOf(card)).toEqual([["Urgency", "Importance", "Due"], ["↶ Undo", "Open in PPM"], ["💬 Message about this task"]]);
    expect(button(card, "Open in PPM").url).toStartWith(`${LINK}/project/ppm?openTask=`);
  });

  it("sets urgency from an inline choice, as the user", async () => {
    const card = fake.sent(PHONE).findLast((m) => m.text.startsWith("Created in"))!;
    await press(card, "Urgency");
    expect(buttonsOf(fake.sent(PHONE).find((m) => m.message_id === card.message_id)!)).toEqual([["Now", "Today", "● This week"], ["Later"], ["‹ Back"]]);
  });

  it("undoes the creation", async () => {
    const card = () => fake.sent(PHONE).findLast((m) => m.text.startsWith("Created in"))!;
    expect(await press(card(), "Now")).toBe("Urgency: Now");
    const taskId = new URL(button(card(), "Open in PPM").url!).searchParams.get("openTask")!;
    expect(getTask(taskId)!.urgency).toBe("now");
    expect(taskHistory(taskId)[0]!.via).toBe("telegram");
    expect(await press(card(), "↶ Undo")).toBe("Undone");
    expect(getTask(taskId)!.deletedAt).not.toBeNull();
    expect(card().text).toContain("Undone: the task was removed.");
    expect(buttonsOf(card())).toEqual([]);
  });
});

describe("the Assistant's task cards", () => {
  it("the while-you-were-away card offers a real Undo per change and Open chat per task", async () => {
    const away: WriteContext = { actor: { kind: "assistant", sessionId: assistant, label: "Assistant" }, via: "tool", unattended: true };
    const t = getTask(ids.nxLater)!;
    const updated = updateTask(ids.nxLater, { urgency: "today" }, t.revision, away);
    const historyId = taskHistory(ids.nxLater)[0]!.id;
    expect(updated.urgency).toBe("today");
    noteUnattendedChange(assistant, {
      historyId, projectKey: keys.nxsys, taskId: ids.nxLater, ref: `nxsys/${updated.number}`,
      summary: `nxsys/${updated.number} "Dọn log cũ": urgency Later → Today`,
    });
    // ppm keeps its details off the phone: its change shows the ref and title only, with no Undo.
    const secret = getTask(ids.ppmToday)!;
    const hidden = updateTask(ids.ppmToday, { notes: "client ACME salaries v2" }, secret.revision, away);
    const hiddenId = taskHistory(ids.ppmToday)[0]!.id;
    noteUnattendedChange(assistant, {
      historyId: hiddenId, projectKey: keys.ppm, taskId: ids.ppmToday, ref: `ppm/${hidden.number}`,
      summary: `ppm/${hidden.number} "Secret client payroll fix": notes changed to client ACME salaries v2`,
    });
    const before = fake.sent(PHONE).length;
    flushUnattendedChanges(assistant);
    const card = await fake.waitFor(() => fake.sent(PHONE).slice(before).find((m) => m.text.includes("while you were away")));
    expect(card.text).toContain(`nxsys/${updated.number} "Dọn log cũ": urgency Later → Today · undo #${historyId}`);
    expect(card.text).toContain(`ppm/${hidden.number} "Secret client payroll fix" (details in PPM)`);
    expect(card.text).not.toContain("ACME");
    expect(buttonsOf(card).flat()).not.toContain(`↶ Undo #${hiddenId}`);
    expect(buttonsOf(card)).toContainEqual([`↶ Undo #${historyId}`]);
    expect(buttonsOf(card).flat()).toContain(`Open chat · nxsys/${updated.number}`);
    expect(button(card, `Open chat · nxsys/${updated.number}`).url).toContain("openChat=claude/mgr-nxsys");

    expect(await press(card, `↶ Undo #${historyId}`)).toBe(`Undone #${historyId}`);
    expect(getTask(ids.nxLater)!.urgency).toBe("later");
    const after = fake.sent(PHONE).find((m) => m.message_id === card.message_id)!;
    expect(buttonsOf(after).flat()).not.toContain(`↶ Undo #${historyId}`);
  });

  it("the handed-off work card offers Open chat per task", async () => {
    const before = fake.sent(PHONE).length;
    assistantCards.create({
      kind: "needs_decision", projectName: "nxsys", projectPath: paths.nxsys, projectKey: keys.nxsys, sessionId: "mgr-nxsys",
      title: "Handed-off work needs you", body: "nxsys/1 stalled 40 min",
      payload: { detected: true, tasks: [{ taskId: ids.psr, sessionId: "child-1", ref: "nxsys/1" }] },
    });
    const card = await fake.waitFor(() => fake.sent(PHONE).slice(before).find((m) => m.text.includes("Handed-off work needs you")));
    expect(button(card, "Open chat · nxsys/1").url).toBe(`${LINK}/project/nxsys?openChat=claude/child-1`);
  });
});

describe("writing to the chat working on a task", () => {
  const taskBlock = (id: string) => `task_id ${id}`;
  const lastCallWith = (text: string) => fake.waitFor(() => providerCalls.findLast((c) => c.startsWith(text)));
  /** Types words meant for a task's chat: the bot answers by editing its prompt, not with a new message. */
  async function typeWords(text: string): Promise<string> {
    fake.pushText(PHONE, PHONE, text);
    const call = await lastCallWith(text);
    await settle();
    return call;
  }
  /** A fresh `/tasks <project>` deck, paged to the card of the task titled `title`. */
  async function cardOf(project: string, title: string): Promise<FakeSentMessage> {
    await send(`/tasks ${project}`);
    for (let i = 0; i < 8 && !deckMessage().text.includes(title); i++) await press(deckMessage(), "›");
    const deck = deckMessage();
    expect(deck.text).toContain(title);
    return deck;
  }
  const psrCard = () => cardOf("nxsys", "PSR Ireland bỏ sót payslip");

  it("arms the next message for the manager chat, says which task and chat, and sends it there with the task's block", async () => {
    const deck = await psrCard();
    const before = fake.sent(PHONE).length;
    const toast = await press(deck, "💬 Message about this task");
    expect(toast).toBe("Your next message goes to the chat working on nxsys/1");
    const prompt = await fake.waitFor(() => fake.sent(PHONE).slice(before).find((m) => m.text.includes("Your next message goes to")));
    expect(prompt.text).toContain("Your next message goes to the nxsys manager chat, about nxsys/1 · PSR Ireland bỏ sót payslip.");
    expect(buttonsOf(prompt)).toEqual([["Cancel"]]);

    const call = await typeWords("sửa ngay task này giúp anh");
    expect(call).toContain("<ppm-user-words-v1>");
    expect(call).toContain("sent on Telegram");
    expect(call).toContain("<ppm-taskref-v1>");
    expect(call).toContain(taskBlock(ids.psr));
    expect(call).toContain('"PSR Ireland bỏ sót payslip"');
    const after = await fake.waitFor(() => fake.sent(PHONE).find((m) => m.message_id === prompt.message_id && m.text.startsWith("✅")));
    expect(after.text).toBe("✅ Sent to the nxsys manager chat, about nxsys/1 · PSR Ireland bỏ sót payslip.");
    expect(buttonsOf(after)).toEqual([]);

    // One message only: the next goes to the Assistant as usual.
    const calls = providerCalls.length;
    await send("cảm ơn");
    await fake.waitFor(() => providerCalls.length > calls);
    expect(providerCalls.at(-1)).not.toContain("<ppm-taskref-v1>");
  });

  it("a handed-off task's words go to its own chat with no task block, named only where the project shows details", async () => {
    const task = getTask(ids.psr)!;
    updateTask(ids.psr, { workingSessionId: "child-1" }, task.revision, USER);
    try {
      const deck = await psrCard();
      const before = fake.sent(PHONE).length;
      await press(deck, "💬 Message about this task");
      const prompt = await fake.waitFor(() => fake.sent(PHONE).slice(before).find((m) => m.text.includes("Your next message goes to")));
      expect(prompt.text).toContain("the chat “child-1” working on it, about nxsys/1");
      // That chat works on this task alone: the words go as they are, with no task block.
      const call = await typeWords("child, check the period-13 filter");
      expect(call).toContain("<ppm-user-words-v1>");
      expect(call).not.toContain("<ppm-taskref-v1>");
      expect(call).not.toContain(taskBlock(ids.psr));
      const said = await fake.waitFor(() => fake.sent(PHONE).find((m) => m.message_id === prompt.message_id && m.text.startsWith("✅")));
      expect(said.text).toBe("✅ Sent to the chat “child-1” working on it, about nxsys/1 · PSR Ireland bỏ sót payslip.");

      // A reply to the task's card goes there the same way.
      const card = await psrCard();
      const shown = fake.sent(PHONE).length;
      fake.pushText(PHONE, PHONE, "child, reply about this one", "private", {
        reply_to_message: { message_id: card.message_id, chat: { id: PHONE, type: "private" }, date: Math.floor(Date.now() / 1000), text: card.text },
      });
      const replied = await lastCallWith("child, reply about this one");
      expect(replied).not.toContain("<ppm-taskref-v1>");
      const sentBack = await fake.waitFor(() => fake.sent(PHONE).slice(shown).find((m) => m.text.startsWith("✅ Sent to")));
      expect(sentBack.text).toBe("✅ Sent to the chat “child-1” working on it, about nxsys/1 · PSR Ireland bỏ sót payslip.");
    } finally {
      const t = getTask(ids.psr)!;
      updateTask(ids.psr, { workingSessionId: null }, t.revision, USER);
    }
  });

  it("a title-only project shows the ref and title, nothing more", async () => {
    const deck = await cardOf("ppm", "Secret client payroll fix");
    const before = fake.sent(PHONE).length;
    await press(deck, "💬 Message about this task");
    const prompt = await fake.waitFor(() => fake.sent(PHONE).slice(before).find((m) => m.text.includes("Your next message goes to")));
    expect(prompt.text).toContain("the ppm manager chat, about ppm/");
    expect(prompt.text).toContain("Secret client payroll fix");
    expect(prompt.text).not.toContain("ACME");
    expect(await press(prompt, "Cancel")).toBe("Cancelled");
  });

  it("Cancel and the time limit both send nothing and say so", async () => {
    const deck = await psrCard();
    let before = fake.sent(PHONE).length;
    await press(deck, "💬 Message about this task");
    const prompt = await fake.waitFor(() => fake.sent(PHONE).slice(before).find((m) => m.text.includes("Your next message goes to")));
    expect(await press(prompt, "Cancel")).toBe("Cancelled");
    const cancelled = fake.sent(PHONE).find((m) => m.message_id === prompt.message_id)!;
    expect(cancelled.text).toBe("Cancelled. Nothing was sent about nxsys/1 · PSR Ireland bỏ sót payslip.");
    const calls = providerCalls.length;
    await send("đi ngủ thôi");
    await fake.waitFor(() => providerCalls.length > calls);
    expect(providerCalls.at(-1)).not.toContain("<ppm-taskref-v1>");

    before = fake.sent(PHONE).length;
    await press(deckMessage(), "💬 Message about this task");
    const second = await fake.waitFor(() => fake.sent(PHONE).slice(before).find((m) => m.text.includes("Your next message goes to")));
    advance(10 * 60_000 + 1);
    await settle();
    const expired = await fake.waitFor(() => fake.sent(PHONE).find((m) => m.message_id === second.message_id && m.text.startsWith("Not waiting")));
    expect(expired.text).toBe("Not waiting any more. Nothing was sent about nxsys/1 · PSR Ireland bỏ sót payslip.");
    expect(buttonsOf(expired)).toEqual([]);
  });

  it("a reply to a task card goes to that task's chat, with nothing to arm", async () => {
    const deck = await psrCard();
    const before = fake.sent(PHONE).length;
    fake.pushText(PHONE, PHONE, "reply about this one", "private", {
      reply_to_message: { message_id: deck.message_id, chat: { id: PHONE, type: "private" }, date: Math.floor(Date.now() / 1000), text: deck.text },
    });
    const call = await lastCallWith("reply about this one");
    expect(call).toContain(taskBlock(ids.psr));
    const said = await fake.waitFor(() => fake.sent(PHONE).slice(before).find((m) => m.text.startsWith("✅ Sent to")));
    expect(said.text).toBe("✅ Sent to the nxsys manager chat, about nxsys/1 · PSR Ireland bỏ sót payslip.");
  });

  it("the chat's answer comes back under the user's own message, once, naming the chat and the task", async () => {
    const deck = await psrCard();
    const before = fake.sent(PHONE).length;
    await press(deck, "💬 Message about this task");
    await fake.waitFor(() => fake.sent(PHONE).slice(before).find((m) => m.text.includes("Your next message goes to")));
    const update = fake.pushText(PHONE, PHONE, "is it still blocked?");
    const userMessageId = update.message!.message_id;
    await lastCallWith("is it still blocked?");
    // The scripted provider never names its turn (Claude does), so the follower judges it after its grace.
    await settle();
    advance(FOLLOWUP_GRACE_MS + 100);
    const answer = await fake.waitFor(() => fake.sent(PHONE).find((m) => m.reply_to === userMessageId && m.text.includes("answered")));
    expect(answer.text.split("\n").slice(0, 2)).toEqual([
      "💬 The nxsys manager chat answered, about nxsys/1 · PSR Ireland bỏ sót payslip:", "Noted.",
    ]);
    expect(JSON.stringify(answer)).toContain("openChat=claude/mgr-nxsys");
    // The next message goes to the Assistant, and its answer is not sent under the old message.
    const calls = providerCalls.length;
    await send("cảm ơn nhé");
    await fake.waitFor(() => providerCalls.length > calls);
    await settle();
    expect(fake.sent(PHONE).filter((m) => m.reply_to === userMessageId)).toHaveLength(1);
  });

  it("a title-only project's answer stays in PPM: only that the chat answered, and the link", async () => {
    const deck = await cardOf("ppm", "Secret client payroll fix");
    const before = fake.sent(PHONE).length;
    await press(deck, "💬 Message about this task");
    await fake.waitFor(() => fake.sent(PHONE).slice(before).find((m) => m.text.includes("Your next message goes to")));
    const update = fake.pushText(PHONE, PHONE, "status of the ACME salaries?");
    const userMessageId = update.message!.message_id;
    await lastCallWith("status of the ACME salaries?");
    await settle();
    advance(FOLLOWUP_GRACE_MS + 100);
    const answer = await fake.waitFor(() => fake.sent(PHONE).find((m) => m.reply_to === userMessageId && m.text.includes("answered")));
    expect(answer.text).toContain("The ppm manager chat answered, about ppm/");
    expect(answer.text).toContain("details stay in PPM");
    expect(answer.text).not.toContain("Noted.");
    expect(answer.text).not.toContain("ACME");
  });

  it("a forwarded message is not the user's words, and is not sent", async () => {
    const deck = await psrCard();
    const before = fake.sent(PHONE).length;
    await press(deck, "💬 Message about this task");
    await fake.waitFor(() => fake.sent(PHONE).slice(before).find((m) => m.text.includes("Your next message goes to")));
    const calls = providerCalls.length;
    const shown = fake.sent(PHONE).length;
    fake.pushText(PHONE, PHONE, "someone else's text", "private", { forward_origin: { type: "hidden_user", sender_user_name: "Bob", date: 1 } });
    const said = await fake.waitFor(() => fake.sent(PHONE).slice(shown).find((m) => m.text.includes("forwarded message")));
    expect(said.text).toContain("not sent to the task's chat");
    expect(providerCalls.length).toBe(calls);
  });
});
