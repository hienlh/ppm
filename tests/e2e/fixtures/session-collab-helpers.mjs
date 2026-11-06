// Shared helpers for the session-collaboration e2e (tests/e2e/session-collab-e2e.mjs): sessions
// made and titled through the API, scripted turns, the fixture's call and turn logs, one chat
// shown alone in the workspace, sending from its composer, and reading a tool's JSON answer.
import { COMPOSER } from "./session-turn-refs-helpers.mjs";

export { COMPOSER };
export const PROJECT = "alpha";

export function collabKit(kit, web) {
  const route = (path, init) => kit.api(`/__collab-test${path}`, init);
  const postRoute = (path, body) => kit.post(`/__collab-test${path}`, body);

  /** A user-started chat, titled as a person would title it. */
  async function newSession(providerId, title) {
    const created = await kit.post(`/api/project/${PROJECT}/chat/sessions`, { providerId, title });
    await postRoute("/title", { sessionId: created.data.id, title });
    return { id: created.data.id, providerId, title };
  }

  /** Queue scripted turns for a session id or for `title:<title>` (a session created mid-run). */
  const plan = (key, ...plans) => postRoute("/plan", { key, plans });
  const steps = (...list) => ({ steps: list });
  const calls = async () => (await route("/calls")).calls;
  const sends = async () => (await route("/sends")).sends;
  const release = (sessionId) => postRoute("/release", sessionId ? { sessionId } : {});
  const canonical = async (id) => (await route(`/live?sessionId=${encodeURIComponent(id)}`)).canonical;
  const live = async (id) => (await route(`/live?sessionId=${encodeURIComponent(id)}`)).live;

  /** The calls made after `from` that match, once `n` of them have an answer. */
  async function answered(from, n, match = () => true, timeout = 30000) {
    return kit.until(`${n} answered call(s)`, async () => {
      const mine = (await calls()).slice(from).filter(match);
      return mine.length >= n && mine.slice(0, n).every((c) => c.text !== undefined) ? mine.slice(0, n) : null;
    }, timeout, 150);
  }

  /** The project's session list as the server answers it. */
  async function listed() {
    return (await kit.api(`/api/project/${PROJECT}/chat/sessions?limit=200`)).data.sessions;
  }
  const findListed = (title, timeout = 20000) => kit.until(`"${title}" in the session list`, async () => (await listed()).find((s) => s.title === title), timeout, 200);

  /** Shows exactly these chats as tabs of one panel, the first one open. */
  async function show(page, sessions) {
    const tabs = sessions.map((s) => ({
      id: `chat:${s.providerId}/${s.id}`, type: "chat", title: s.title, projectId: PROJECT, closable: true,
      metadata: { projectName: PROJECT, sessionId: s.id, providerId: s.providerId },
    }));
    await kit.api(`/api/project/${PROJECT}/workspace`, { method: "PUT", body: JSON.stringify({ layout: {
      panels: { main: { id: "main", tabs, activeTabId: tabs[0].id, tabHistory: tabs.map((t) => t.id) } }, grid: [["main"]], focusedPanelId: "main",
    } }) });
    await page.evaluate((p) => localStorage.removeItem(`ppm-panels-${p}`), PROJECT);
    await page.goto(`${web}/project/${PROJECT}`);
    await page.locator(`${COMPOSER}:visible`).first().waitFor({ timeout: 30000 });
  }

  async function send(page, text) {
    const box = page.locator(`${COMPOSER}:visible`).first();
    await box.fill(text);
    await box.press("Enter");
  }

  return { newSession, plan, steps, calls, sends, release, canonical, live, answered, listed, findListed, show, send, route, postRoute };
}

/** A session tool's answer: its JSON, or null for a refusal written as text. */
export function resultOf(call) {
  try { return JSON.parse(call.text); } catch { return null; }
}
