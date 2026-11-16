// Desktop steps of tests/e2e/ppm-tasks-e2e.mjs (1440 × 900): the Tasks section and the task's own
// tab, a new task and "Tell the manager now?", a Decision sent word for word, Start chat, the
// manager chat's Tasks chip, a stale save, an AI change undone, a project turned off and on, and
// the Settings → Tools switch.
import assert from "node:assert/strict";
import { until } from "./tasks-kit.mjs";

const ORDER = ["now", "today", "week", "later"];

/** Scenarios 1–3, 7 (scene 1): the list in "what to do first" order, one project and all, split view. */
async function listAndDetail(k, s) {
  const page = k.page;
  await k.scene("s1", "Tasks live in the project sidebar", "One project or all projects, in “what to do first” order; a task opens beside the list like a file.");
  await k.openTasks();
  await page.getByRole("tab", { name: "alpha" }).first().click().catch(() => {});
  await k.row(s.t.login.title).waitFor({ timeout: 20000 });
  // Groups Now › Today › This week › Later, each present once and in that order.
  const groups = await page.locator("[data-tasks-panel]:visible [data-task-group]").evaluateAll((els) => els.map((e) => e.getAttribute("data-task-group")));
  assert.deepEqual(groups.filter((g) => ORDER.includes(g)), ORDER.filter((g) => groups.includes(g)), `groups in order: ${groups}`);
  // Due tomorrow raises a Later task to Today with the auto mark; its history is only its creation.
  const copy = await k.task(s.t.copy.id);
  assert.equal(copy.urgency, "later");
  assert.equal(copy.effectiveUrgency, "today");
  assert.equal(copy.urgencyRaised, true);
  const copyRow = k.row(s.t.copy.title);
  assert.equal(await copyRow.evaluate((el) => el.closest("[data-task-group]")?.getAttribute("data-task-group")), "today", "the raised task shows under Today");
  assert.equal((await k.history(s.t.copy.id)).history?.length ?? (await k.history(s.t.copy.id)).length, 1, "raising by date writes no history");
  // A parent shows its children's progress.
  assert.match(await k.row(s.t.login.title).innerText(), /1\/3/, "the parent shows 1/3");
  await k.beat();
  await k.selectTask(s.t.login.title);
  await k.beat(1500);
  await k.shot("02-list-and-detail-1440");
  // All projects: alpha and beta merged, each row with its project chip.
  await page.getByRole("tab", { name: "All projects" }).click();
  await k.row(s.t.sprite.title).waitFor({ timeout: 15000 });
  assert.match(await k.row(s.t.sprite.title).innerText(), /beta/);
  await k.beat(1500);
  // A status filter does not change the parent's 1/3 (the count is over the whole scope).
  await page.getByRole("tab", { name: "alpha" }).first().click();
  await k.row(s.t.login.title).waitFor();
  await k.endScene();
  k.record("1-3,7", "list ordered Now › Today › This week › Later, due-tomorrow raised with the auto mark and no history, 1/3 progress, all-projects merge");
}

/** Scenarios 1, 10: a project with Tasks off, turned on; turned off again and back with its tasks. */
async function projectSwitch(k, s) {
  const before = (await k.fx.api("/api/tasks/projects")).data.find((p) => p.name === "gamma");
  assert.equal(before.enabled, false, "gamma (no manager) starts with Tasks off");
  await k.page.goto(`${k.web}/project/gamma`);
  await k.openTasks();
  await k.page.locator("[data-tasks-off]:visible").waitFor({ timeout: 20000 });
  await k.page.locator("[data-tasks-off]:visible").getByRole("button", { name: /Turn on/ }).click();
  await until("gamma's tasks on", async () => (await k.fx.api("/api/tasks/projects")).data.find((p) => p.name === "gamma").enabled);
  const statuses = (await k.settings("gamma")).statuses.map((x) => x.name);
  for (const name of ["To do", "In progress", "Waiting", "Done", "Dropped"]) assert(statuses.includes(name), `default status ${name} in ${statuses}`);
  // Off hides beta's tasks from the list and the tools; on brings them back untouched.
  const sprite = await k.task(s.t.sprite.id);
  await k.saveSettings("beta", { enabled: false });
  assert(!(await k.tasks("all")).some((t) => t.project === "beta"), "beta's tasks are hidden while off");
  const [listed] = await k.chatTurn("beta", s.managers.beta, "beta-list-off", [{ session: "ppm_task_list", args: { project: "beta" } }], "List beta tasks while off");
  assert.equal(listed.isError, true, `the tool refuses an off project: ${listed.text}`);
  await k.saveSettings("beta", { enabled: true });
  const back = await k.task(s.t.sprite.id);
  assert.equal(back.revision, sprite.revision, "turning the store off and on changed nothing in the task");
  await k.page.goto(`${k.web}/project/alpha`);
  await k.openTasks();
  k.record("1,10", "gamma off → Turn on → default statuses; beta off hides list and tools, on brings tasks back intact");
}

/** Scenarios 2, 11 (scene 2): New task, an edit, "Tell the manager now?" — Tell now and Next turn. */
async function newTaskAndManagerPrompt(k, s) {
  const page = k.page;
  await k.scene("s2", "Create and edit a task", "After you change a task of a project with a manager chat, PPM asks whether to tell the manager now or at its next turn.");
  await k.openTasks();
  await page.getByRole("button", { name: "New task" }).first().click();
  const dialog = page.locator("[data-task-new-dialog]");
  await dialog.waitFor();
  await dialog.locator("#task-new-title").fill("Write the release notes for 2.15");
  await k.beat(600);
  await dialog.locator("#task-new-urgency").selectOption("today");
  await dialog.getByRole("button", { name: "Create task" }).click();
  const created = await until("the new task", async () => (await k.tasks("alpha")).find((t) => t.title === "Write the release notes for 2.15"));
  s.t.notes = created;
  await k.detail().getByText("Write the release notes for 2.15").first().waitFor({ timeout: 20000 });
  // The creation itself asks about the manager; this run answers on the edit below.
  const prompt = page.locator("[data-task-manager-prompt]");
  if (await prompt.first().isVisible().catch(() => false)) await prompt.getByRole("button", { name: "Next turn" }).first().click();
  await k.beat();
  const managerTurns = (await k.messages(s.managers.alpha)).length;
  await k.detail().getByLabel("Urgency").selectOption("now");
  await prompt.first().waitFor({ timeout: 15000 });
  await k.beat(1200);
  await k.shot("05-tell-manager-toast-1440");
  await prompt.getByRole("button", { name: "Tell now" }).click();
  const told = await until("the manager woken", async () => (await k.messages(s.managers.alpha)).slice(managerTurns).find((m) => m.origin === "ppm_ui"));
  assert.match(told.text, /asked PPM to tell you now about changes in alpha/);
  assert.match(told.text, /Write the release notes for 2\.15/);
  await k.idle(s.managers.alpha);
  // Next turn: nothing is sent now; the manager's next turn carries the news.
  const count = (await k.messages(s.managers.alpha)).length;
  await k.detail().getByLabel("Importance").selectOption("must");
  await prompt.first().waitFor({ timeout: 15000 });
  await prompt.getByRole("button", { name: "Next turn" }).first().click();
  await k.beat(1500);
  assert.equal((await k.messages(s.managers.alpha)).length, count, "Next turn sends nothing");
  await k.endScene();
  await k.script("alpha-next-turn", [], { match: "Anything new on tasks?", sessionId: s.managers.alpha });
  await k.say("alpha", s.managers.alpha, "Anything new on tasks?");
  const turn = await until("the manager's next turn", async () => (await k.fx.turnsOf("alpha-next-turn"))[0]);
  assert.match(turn.sharedContext ?? "", /Write the release notes for 2\.15/, "the next turn carries the news");
  await k.idle(s.managers.alpha);
  k.record("2,11", "New task created; edit asks once; Tell now wakes the manager (ppm_ui); Next turn sends nothing and the news rides the next turn");
}

/** Scenario 6 (scene 3): Choose B → the manager chat gets the option word for word; no browser needed. */
async function decision(k, s) {
  const page = k.page;
  await k.scene("s3", "A Decision task", "Pick an option and PPM sends it word for word to the chat working on the task — here the manager.");
  await k.selectTask(s.t.decision.title);
  const card = k.detail().locator('[data-task-card="decision"]');
  await card.waitFor();
  await k.beat(1200);
  const before = (await k.messages(s.managers.alpha)).length;
  await card.getByRole("button", { name: "Choose B" }).click();
  const got = await until("the choice in the manager chat", async () => (await k.messages(s.managers.alpha)).slice(before).find((m) => m.origin === "ppm_ui"));
  assert.match(got.text, /Decision on alpha\/\d+ "Pick the layout for the pricing page": B — One plan with a usage slider/);
  const hist = await k.history(s.t.decision.id);
  assert((hist.history ?? hist).some((h) => h.kind === "decided"), "history has the decision");
  await page.getByText(/Choice sent to the manager chat/).first().waitFor({ timeout: 10000 });
  await k.beat(1000);
  // Show where it went: the manager chat, from the working-session block.
  await k.detail().getByRole("button", { name: "Open chat" }).first().click();
  // The chat's copy: the task's own (its decision card) is in a window that went to the dock.
  await page.getByText("One plan with a usage slider").and(page.locator("*:visible")).last().waitFor({ timeout: 20000 });
  await k.beat(2000);
  await k.endScene();
  // The same with no browser on that chat: the route alone sends it to beta's manager.
  const t = await k.task(s.t.betaDecision.id);
  const optionId = t.decision.options[1].id;
  const r = await k.fx.call(`/api/tasks/${t.id}/decide`, { method: "POST", body: JSON.stringify({ revision: t.revision, optionId }) });
  assert.equal(r.ok, true, JSON.stringify(r.body));
  await until("beta's manager got the choice", async () => (await k.messages(s.managers.beta)).find((m) => m.origin === "ppm_ui" && /B — Guided tour/.test(m.text)));
  k.record("6", "Choose B → decided in history → manager chat gets the option word for word (ppm_ui); the route alone delivers with no browser on the chat");
}

/** Leftover 1 + Decision 5 (scene 4): no chat can take a choice → Start chat and send; the chat works. */
async function startChat(k, s) {
  const page = k.page;
  const gammaDecision = await k.createTask({ project: "gamma", title: "Choose the export format", type: "decision", urgency: "today", importance: "must",
    decision: { question: "Which export format?", options: ["CSV", "Excel workbook"] } });
  s.t.gammaDecision = gammaDecision;
  await page.goto(`${k.web}/project/gamma`);
  await k.scene("s4", "Start chat", "gamma has no manager chat: picking an option offers Start chat, which opens a new chat for the task and sends it the choice.");
  await k.selectTask(gammaDecision.title);
  await k.beat(1000);
  await k.detail().locator('[data-task-card="decision"]').getByRole("button", { name: "Choose A" }).click();
  const toast = page.getByRole("button", { name: "Start chat and send" });
  await toast.waitFor({ timeout: 15000 });
  await k.beat(1200);
  await k.script("gamma-chat-first", [{ text: "Got it: CSV. I will start with the export columns." }], { match: "Decision on gamma/" });
  await toast.click();
  const linked = await until("the task's new working chat", async () => {
    const t = await k.task(gammaDecision.id);
    return t.workingSession.kind === "session" ? t : null;
  });
  const chatId = linked.workingSession.session.sessionId;
  const first = await until("the choice reached the new chat", async () => (await k.messages(chatId)).find((m) => m.origin === "ppm_ui"));
  assert.match(first.text, /A — CSV/);
  assert.equal(linked.workingSession.session.title, gammaDecision.title, "the chat is titled after the task");
  await page.getByText("Got it: CSV").last().waitFor({ timeout: 20000 });
  await k.beat(2500);
  await k.endScene();
  s.gammaChat = chatId;
  k.record("4b", "no_session choice → Start chat and send → new chat titled after the task gets the choice (ppm_ui) and answers");
}

/** Scenario 9 desktop (scene 5): the manager chat's Tasks chip and its popover; a row reveals the task. */
async function managerChip(k, s) {
  const page = k.page;
  await page.goto(`${k.web}/project/alpha`);
  await k.selectTask(s.t.release.title);
  await k.scene("s5", "The Tasks chip in the manager chat", "Above the composer: open tasks and how many are Now; it opens a short list, one tap away from each task.");
  const taskWindow = page.locator('[aria-roledescription="window"]', { has: page.locator(`[data-task-detail="${s.t.release.id}"]`) });
  await k.detail().getByRole("button", { name: "Open chat" }).first().click();
  const chip = page.locator("[data-manager-tasks-chip]:visible").first();
  await chip.waitFor({ timeout: 20000 });
  // The task's window went to the dock, so nothing covers the chat it opened.
  await until("the task window went to the dock", async () => !(await taskWindow.isVisible()), 10000);
  assert.match(await chip.getAttribute("aria-label"), /^Tasks: \d+ open, \d+ now$/);
  await k.beat(1000);
  await chip.click();
  const rows = page.locator("[data-chip-task]:visible");
  await rows.first().waitFor({ timeout: 15000 });
  await k.beat(1500);
  await k.shot("09-manager-chip-popover-1440");
  await rows.filter({ hasText: s.t.login.title }).first().click();
  await k.detail().getByText(s.t.login.title).first().waitFor({ timeout: 15000 });
  await k.beat(1200);
  await k.endScene();
  k.record("9a", "manager chat Tasks chip with counts; popover lists tasks; a row opens the task");
}

/** Scenarios 4, 5: a stale save is refused whole; an AI change shows in History and Undo restores it. */
async function staleAndUndo(k, s) {
  const t = await k.task(s.t.review.id);
  const ok = await k.patch(t.id, { revision: t.revision, notes: "First editor" });
  assert.equal(ok.ok, true);
  const stale = await k.patch(t.id, { revision: t.revision, notes: "Second editor", urgency: "now" });
  assert.equal(stale.status, 409, "the second save on the old revision is refused");
  assert.equal(stale.body.code, "stale");
  const after = await k.task(t.id);
  assert.equal(after.notes, "First editor");
  assert.equal(after.urgency, "week", "nothing of the refused save was written");

  const fresh = await k.task(s.t.reply.id);
  const [call] = await k.chatTurn("alpha", s.managers.alpha, "mgr-urgency", [{ session: "ppm_task_update", args: { task: fresh.ref, revision: fresh.revision, reason: "The customer asked again this morning.", urgency: "now" } }], "Raise the reply task");
  assert.equal(call.isError, false, call.text);
  assert.equal((await k.task(fresh.id)).urgency, "now");
  await k.idle(s.managers.alpha);
  await k.selectTask(fresh.title);
  const historyCard = k.detail().locator('[data-task-card="history"]');
  const undo = historyCard.getByRole("button", { name: /^Undo: Manager alpha/ }).first();
  await undo.waitFor({ timeout: 15000 });
  await undo.click();
  await until("urgency restored", async () => (await k.task(fresh.id)).urgency === "today");
  await historyCard.locator("[data-undone]").first().waitFor({ timeout: 15000 });
  k.record("4,5", "stale save → 409 with nothing written; manager's ppm_task_update shows as an AI change with Undo; Undo restores and strikes the row");
}

/** Scenario 13: Settings → Tools "Tasks" off takes the tool away from a manager chat; on gives it back. */
async function toolsSwitch(k, s) {
  const ai = (await k.fx.api("/api/settings/ai")).data;
  const tools = { ...(ai.ppm_tools ?? {}) };
  const put = (ppmTools) => k.fx.api("/api/settings/ai", { method: "PUT", body: JSON.stringify({ ppm_tools: ppmTools }) });
  await put({ ...tools, ppm_task_list: false });
  const [off] = await k.chatTurn("alpha", s.managers.alpha, "tools-off", [{ session: "ppm_task_list", args: {} }], "List tasks with the switch off");
  assert.equal(off.isError, true, `refused while off: ${off.text}`);
  assert.match(off.text, /off|turned off|Settings/i);
  await k.idle(s.managers.alpha);
  await put({ ...tools, ppm_task_list: true });
  const [on] = await k.chatTurn("alpha", s.managers.alpha, "tools-on", [{ session: "ppm_task_list", args: {} }], "List tasks with the switch on");
  assert.equal(on.isError, false, on.text);
  await k.idle(s.managers.alpha);
  k.record("13", "Settings → Tools ppm_task_list off: a manager chat's call is refused; back on: it works");
}

export const DESKTOP_STEPS = [
  { id: "list-detail", run: listAndDetail },
  { id: "project-switch", run: projectSwitch },
  { id: "new-task-prompt", run: newTaskAndManagerPrompt },
  { id: "decision", run: decision },
  { id: "start-chat", run: startChat },
  { id: "manager-chip", run: managerChip },
  { id: "stale-undo", run: staleAndUndo },
  { id: "tools-switch", run: toolsSwitch },
];
