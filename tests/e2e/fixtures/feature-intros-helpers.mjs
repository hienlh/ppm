// Helpers for the new-feature introduction e2e (tests/e2e/feature-intros-e2e.mjs): a fresh install
// per scenario (its own fixture server, PPM_HOME and port), seeding one that is already in use,
// opening a desktop or phone page on it, the tour's feature step, chats and Settings → Tools.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { COMPOSER } from "./session-turn-refs-helpers.mjs";

/** The six tools the first introduced feature covers, as Settings → Tools names them. */
export const INTRO_TOOLS = ["create_session", "list_session_turns", "read_session_turns", "search_sessions", "send_to_session", "session_status"];
export const INTRO_TITLE = "Sessions that read and message each other";
export const PROJECT = "alpha";
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

/** This device's basic tour, put away, so the only panel on screen is the feature step. */
export function tourDismissed() {
  if (window.top !== window) return;
  localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
}

/**
 * This device's basic tour running at its last step (the "ai" route, after the tour's own chat was
 * sent), written once: a reload keeps what the app stored since, as a real browser would.
 */
export function tourMidway() {
  if (window.top !== window || localStorage.getItem("ppm-onboarding-v1")) return;
  localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "active", familiarity: "beginner", goal: "ai", currentStep: "history", completed: ["project", "chat", "send"], skipped: [], projectName: "alpha", sessionId: null }));
}

async function freePort() {
  const listener = createServer();
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  return port;
}

/** Starts a fresh install: nothing answered, no project, no chat. `stop()` keeps its log. */
export async function startInstall({ sandbox, artifacts, webDir, kit }, name) {
  const root = join(sandbox, name);
  const ppm = join(root, "ppm"), home = join(root, "home"), projects = join(root, "projects");
  await Promise.all([ppm, home, projects].map((p) => mkdir(p, { recursive: true })));
  const port = await freePort();
  const web = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port),
    PPM_INTRO_WEB_DIR: webDir, PPM_INTRO_PROJECTS: projects,
  };
  delete env.PPM_ALLOW_PROD_DB;
  const child = spawn("bun", ["tests/e2e/fixtures/feature-intros-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const exited = new Promise((r) => child.on("exit", r));

  async function api(path, init = {}) {
    const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });
    const body = await response.json();
    assert(response.ok, `${path}: ${JSON.stringify(body)}`);
    return body;
  }
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });
  const put = (path, body) => api(path, { method: "PUT", body: JSON.stringify(body) });
  try {
    await kit.until(`${name} fixture healthy`, async () => child.exitCode === null && (await fetch(`${web}/api/health`)).ok, 90000, 300);
  } catch (e) {
    throw new Error(`${e.message}\n${log.slice(-2000)}`);
  }
  return {
    name, web, api, post, put,
    /** The stored record and switches, read straight from the install's config. */
    state: () => api("/__intro-test/state"),
    view: async () => (await api("/api/feature-intros")).data,
    turns: async () => (await api("/__intro-test/turns")).turns,
    async stop() {
      if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
      if (child.exitCode === null) child.kill("SIGKILL");
      await writeFile(join(artifacts, `server-${name}.log`), log);
    },
  };
}

/** A project, as `ppm init`'s scan or the tour's first step adds one: not yet a sign of use. */
export async function addProject(install) {
  const { alpha } = await install.api("/__intro-test/project");
  await install.post("/api/projects", { name: PROJECT, path: alpha });
}

/** An install somebody already uses: a project and a chat recorded in it. */
export async function seedInUse(install) {
  await addProject(install);
  assert.equal((await install.view()).isExistingUser, false, "a project alone is not use");
  const chat = await newChat(install, "Earlier chat");
  await install.post("/__intro-test/session-metadata", { sessionId: chat.id });
  assert.equal((await install.view()).isExistingUser, true, "a recorded chat makes the install one in use");
  return chat;
}

export async function newChat(install, title) {
  const created = await install.post(`/api/project/${PROJECT}/chat/sessions`, { providerId: "intro-test", title });
  return { id: created.data.id, title };
}

/**
 * A page on `install`, desktop unless `phone`; `init` runs before the app (e.g. `tourDismissed`).
 * Resolves once the app has asked the server for the pending features.
 */
export async function openPage({ browser }, install, { phone = false, init, path = `/project/${PROJECT}` } = {}) {
  const context = await browser.newContext({ ...(phone ? PHONE : { viewport: { width: 1440, height: 900 } }), serviceWorkers: "block" });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await gotoLoaded(page, `${install.web}${path}`);
  return { context, page, errors };
}

/** Navigates (or reloads, with no url) and waits for the app's own GET of the pending features. */
export async function gotoLoaded(page, url) {
  const asked = page.waitForResponse((r) => r.url().endsWith("/api/feature-intros") && r.request().method() === "GET", { timeout: 60000 });
  if (url) await page.goto(url); else await page.reload();
  await asked;
}

/** The feature step: a dialog named after the feature's title, on desktop and in the phone's sheet. */
export const featureStep = (page) => page.getByRole("dialog", { name: INTRO_TITLE });
export const stepButton = (page, name) => featureStep(page).getByRole("button", { name, exact: true });

/** Waits `ms` more after load and asserts the feature step never appeared. */
export async function assertNotAsked(page, ms = 2000) {
  await page.waitForTimeout(ms);
  assert.equal(await page.getByText("PPM has new features").count(), 0, "the feature step is not shown");
}

export const tourStatus = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("ppm-onboarding-v1") ?? "null")?.status ?? null);

/** Shows `chat` alone in the workspace and sends `text` from its composer. */
export async function sendInChat(page, install, chat, text) {
  const tab = { id: `chat:intro-test/${chat.id}`, type: "chat", title: chat.title, projectId: PROJECT, closable: true,
    metadata: { projectName: PROJECT, sessionId: chat.id, providerId: "intro-test" } };
  await install.put(`/api/project/${PROJECT}/workspace`, { layout: {
    panels: { main: { id: "main", tabs: [tab], activeTabId: tab.id, tabHistory: [tab.id] } }, grid: [["main"]], focusedPanelId: "main",
  } });
  await page.evaluate((p) => localStorage.removeItem(`ppm-panels-${p}`), PROJECT);
  await gotoLoaded(page, `${install.web}/project/${PROJECT}`);
  const box = page.locator(`${COMPOSER}:visible`).first();
  await box.waitFor({ timeout: 30000 });
  await box.fill(text);
  await box.press("Enter");
}

/** Settings → Tools through the rail's Settings button. */
export async function openTools(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("button", { name: "Tools", exact: true }).first().click();
  await page.getByRole("switch", { name: /create_session/ }).waitFor({ timeout: 15000 });
}

export async function closeSettings(page) {
  await page.getByRole("button", { name: "Close window" }).first().click();
  await page.getByRole("switch", { name: /create_session/ }).waitFor({ state: "detached", timeout: 5000 });
}

// The label is "<copy><code>tool</code>", read as one run with no space before the tool's name.
export const toolSwitch = (page, tool) => page.getByRole("switch", { name: new RegExp(tool) });

/** The basic tour's own offer card (its heading; the "Learn PPM" entry button shares the words). */
export const tourOffer = (page) => page.getByRole("heading", { name: "Get started with PPM" });

/** Every switch of `tools` as `{ tool: on }`, as Settings shows it. */
export async function switchStates(page, tools = INTRO_TOOLS) {
  const out = {};
  for (const tool of tools) out[tool] = (await toolSwitch(page, tool).getAttribute("aria-checked")) === "true";
  return out;
}

export const allSwitches = (on) => Object.fromEntries(INTRO_TOOLS.map((t) => [t, on]));
