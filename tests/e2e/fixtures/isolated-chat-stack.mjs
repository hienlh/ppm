/**
 * Runs one of the older CDP-driven chat e2e scripts against a disposable stack instead of the
 * developer's `bun dev:server` (which opens `~/.ppm/ppm.dev.db`).
 *
 * It starts the new-chat fixture server (isolated PPM_HOME, scripted mock providers, two
 * placeholder Claude accounts) plus Vite, registers a project, optionally seeds the project's
 * saved layout with chat tabs, then runs the target script with PPM_E2E_API / PPM_E2E_WEB /
 * PPM_E2E_PROJECT / PPM_E2E_API_PORT / PPM_E2E_NO_SERVERS pointing at it, and tears the stack
 * down when the script exits. Its exit code is the script's.
 *
 *   node tests/e2e/fixtures/isolated-chat-stack.mjs [--project ppm] [--seed-new-chat-tab]
 *        [--seed-session-tabs N] -- bun tests/e2e/chat-composer-stalled-draft-e2e.mjs [args…]
 *
 * `{WEB}` in the script's own arguments is replaced by the web origin (tab-open-latency takes
 * its origin as an argument).
 *
 * Needs PPM_PLAYWRIGHT_MODULE (+ PPM_PLAYWRIGHT_CHANNEL=chrome), like the harness it uses.
 */
import { spawn } from "node:child_process";
import { createHtmlPreviewHarness } from "./html-preview-harness.mjs";
import { until } from "./new-chat-instant-helpers.mjs";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split < 0 || split === argv.length - 1) {
  console.error("usage: isolated-chat-stack.mjs [options] -- <runner> <script> [args…]");
  process.exit(2);
}
const opts = argv.slice(0, split);
const [runner, ...rest] = argv.slice(split + 1);
const opt = (name, fallback) => { const i = opts.indexOf(name); return i >= 0 ? opts[i + 1] : fallback; };
const project = opt("--project", "ppm");
const seedNewChatTab = opts.includes("--seed-new-chat-tab");
const seedSessionTabs = Number(opt("--seed-session-tabs", "0"));

const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/new-chat-instant-server.ts" });
let code = 1;
try {
  const post = (path, body) => fetch(`${harness.api}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const created = await post("/api/projects", { path: harness.project, name: project });
  if (!created.ok) throw new Error(`project registration: ${created.status}`);

  if (seedNewChatTab || seedSessionTabs > 0) {
    // Seed the server-synced layout the way a user would: open the tabs in a real page and
    // wait for the debounced `PUT /workspace` that saves them.
    const sessions = [];
    for (let i = 0; i < seedSessionTabs; i++) {
      const res = await post(`/api/project/${encodeURIComponent(project)}/chat/sessions`, { providerId: "plain-test", title: `Seeded session ${i + 1}` });
      sessions.push((await res.json()).data);
    }
    const context = await harness.browser.newContext();
    const page = await context.newPage();
    await page.goto(`${harness.web}/project/${encodeURIComponent(project)}`);
    const workspace = page.waitForResponse((r) => r.request().method() === "GET" && r.url().includes("/workspace"), { timeout: 15000 }).catch(() => {});
    await until("the project to be active", () => page.evaluate(async (name) => {
      const { useProjectStore } = await import("/stores/project-store.ts");
      return useProjectStore.getState().activeProject?.name === name;
    }, project), { timeout: 30000, interval: 100 });
    await workspace;
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/workspace"), { timeout: 15000 });
    await page.evaluate(async ({ name, sessions, newTab }) => {
      const { usePanelStore } = await import("/stores/panel-store.ts");
      for (const s of sessions) {
        usePanelStore.getState().openTab({ type: "chat", title: s.title, projectId: name, closable: true, metadata: { projectName: name, sessionId: s.id, providerId: s.providerId } });
      }
      if (newTab) usePanelStore.getState().openTab({ type: "chat", title: "Chat", projectId: name, closable: true, metadata: { projectName: name } });
    }, { name: project, sessions, newTab: seedNewChatTab });
    await saved;
    await context.close();
  }
  await harness.browser.close();

  const apiPort = new URL(harness.api).port;
  const env = {
    ...process.env, PPM_E2E_API: harness.api, PPM_E2E_WEB: harness.web, PPM_E2E_PROJECT: project,
    PPM_E2E_API_PORT: apiPort, PPM_E2E_NO_SERVERS: "1",
  };
  console.log(`[isolated-chat-stack] api=${harness.api} web=${harness.web} project=${project} sandbox=${harness.sandbox}`);
  const child = spawn(runner, rest.map((a) => a.replaceAll("{WEB}", harness.web)), { cwd: process.cwd(), env, stdio: "inherit", windowsHide: true });
  code = await new Promise((done) => child.on("exit", (c) => done(c ?? 1)));
} catch (error) {
  console.error(`[isolated-chat-stack] ${error.stack}`);
} finally {
  await harness.cleanup();
}
process.exit(code);
