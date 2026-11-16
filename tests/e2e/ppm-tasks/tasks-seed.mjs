// The demo world of tests/e2e/ppm-tasks-e2e.mjs, made through PPM's own routes: three projects
// (alpha and beta with a manager chat, gamma without one and with Tasks off), the main Assistant
// session bound to the fake Telegram chat, and neutral tasks in "what to do first" shapes.
import assert from "node:assert/strict";
import { until } from "./tasks-kit.mjs";

/** YYYY-MM-DD `days` from today (UTC, the zone the run sets). */
export const dayFromNow = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export async function seedDemo(k, dirs) {
  const { fx } = k;
  for (const [name, path] of Object.entries(dirs)) await fx.post("/api/projects", { name, path });
  await until("the Telegram bridge runs", async () => (await fx.tg("bridge")).running, 30000);

  const main = (await fx.post("/api/project/__assistant__/chat/sessions", { providerId: "claude", title: "Assistant" })).data.id;
  await fx.post("/api/assistant/telegram/bind", { sessionId: main, chatId: String(k.owner) });
  const { data: { settings } } = await fx.api("/api/assistant/settings");
  // No quiet hours and no digest: nothing may hold a card or fire on a clock of its own here.
  await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...settings, timezone: "UTC", digest: { enabled: false, time: "08:00" }, quiet_hours: { ...settings.quiet_hours, enabled: false } }) });

  const managers = {};
  for (const project of ["alpha", "beta"]) {
    const id = (await fx.post(`/api/project/${project}/chat/sessions`, { providerId: "claude", title: `${project} manager` })).data.id;
    await fx.api(`/api/assistant/managers/${project}`, { method: "PUT", body: JSON.stringify({ sessionId: id }) });
    managers[project] = id;
  }
  // A manager makes the project's task list: switched on by the assignment.
  await until("alpha and beta have tasks on", async () => {
    const list = (await fx.api("/api/tasks/projects")).data;
    return list.filter((p) => p.enabled).map((p) => p.name).sort().join() === "alpha,beta";
  });

  const create = (body) => k.createTask(body);
  const login = await create({ project: "alpha", title: "Fix login timeout on slow networks", urgency: "now", importance: "must", tags: ["auth", "mobile"],
    why: "Users on slow networks see a blank screen after 10 s.", nextStep: "Add a retry with backoff to the token refresh." });
  const kids = [];
  for (const title of ["Reproduce on a throttled connection", "Add retry to the token refresh", "Write a test for the slow path"]) {
    kids.push(await create({ project: "alpha", title, parentId: login.id, urgency: "now", importance: "must" }));
  }
  const firstKid = await k.task(kids[0].id);
  assert.equal((await fx.call(`/api/tasks/${firstKid.id}/close`, { method: "POST", body: JSON.stringify({ revision: firstKid.revision, closedAs: "done" }) })).ok, true);
  const decision = await create({ project: "alpha", title: "Pick the layout for the pricing page", type: "decision", urgency: "today", importance: "must",
    decision: { question: "Which pricing page layout?", options: ["Three plans side by side", "One plan with a usage slider"] } });
  const reply = await create({ project: "alpha", title: "Reply to the customer about the export delay", type: "reply", urgency: "today", importance: "should" });
  const release = await create({ project: "alpha", title: "Prepare release 2.15 for staging", urgency: "week", importance: "must", dueDate: dayFromNow(4) });
  const review = await create({ project: "alpha", title: "Review pull request #412", urgency: "week", importance: "should", tags: ["review"] });
  const copy = await create({ project: "alpha", title: "Update the onboarding copy", urgency: "later", importance: "should", dueDate: dayFromNow(1) });
  const logs = await create({ project: "alpha", title: "Clean old logs on staging", urgency: "later", importance: "nice", tags: ["cleanup"] });
  const betaDecision = await create({ project: "beta", title: "Choose one of three onboarding flows", type: "decision", urgency: "today", importance: "must",
    decision: { question: "Which onboarding flow?", options: ["Checklist", "Guided tour", "Empty states only"] } });
  const sprite = await create({ project: "beta", title: "Draw the sleeping cat sprite", urgency: "week", importance: "should" });

  return {
    ...dirs, main, managers,
    t: { login, kids, decision, reply, release, review, copy, logs, betaDecision, sprite },
  };
}
