// End-to-end Playwright browser test for Google Antigravity integration in PPM.
//
// Starts disposable isolated API + Vite servers (isolated PPM_HOME/HOME/USERPROFILE,
// dynamic ports, zero conflict with any running main PPM process) and drives a real
// headless Chromium browser to verify:
// 1. Antigravity conversation history & tool cards render in the Chat UI
// 2. Clicking the one-line Agent card opens the live portrait Subagent Session Window
//    and streams the Antigravity subagent's transcript.jsonl over /ws/global
// 3. Live-appending a step to the subagent's transcript.jsonl updates the open window in real time
// 4. Typing `/` in the chat input opens the Slash Picker and shows skills from `.agents/skills/`

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";

const PROJECT = "antigravity-e2e";
const SHOTS = process.env.PPM_E2E_SHOTS || "/tmp/ppm-agy-e2e-shots";

const results = [];
const log = (...a) => console.log(...a);
async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    log(`  [PASS] ${name}`);
  } catch (e) {
    results.push({ name, pass: false });
    log(`  [FAIL] ${name} — ${e?.stack ?? e?.message ?? e}`);
  }
}

async function openProjectAndSession(page, { projectName, sessionId, providerId, title }) {
  await page.waitForFunction(async () => !!(await import("/stores/panel-store.ts")).usePanelStore);
  await page.evaluate(async (name) => {
    const projects = (await import("/stores/project-store.ts")).useProjectStore;
    await projects.getState().fetchProjects();
    projects.getState().setActiveProject(projects.getState().projects.find((p) => p.name === name));
    (await import("/stores/tab-store.ts")).useTabStore.getState().switchProject(name);
  }, projectName);
  await page.evaluate(async ({ projectName, sessionId, providerId, title }) => {
    const { usePanelStore } = await import("/stores/panel-store.ts");
    usePanelStore.getState().openTab({
      type: "chat",
      title,
      projectId: projectName,
      closable: true,
      metadata: { projectName, sessionId, providerId },
    });
  }, { projectName, sessionId, providerId, title });
}

const cardButtonSel = 'button[title="Open agent session"]';
const windowSel = '[role="group"][aria-roledescription="window"]';

function pointWsAtFixture({ api }) {
  if (window.top !== window) return;
  try {
    localStorage.setItem("ppm-onboarding-v1", JSON.stringify({
      version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null,
      completed: [], skipped: [], projectName: null, sessionId: null,
    }));
  } catch { /* ignore */ }
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(input, protocols) {
      const url = new URL(String(input), location.href);
      if (url.hostname === "127.0.0.1" && url.port === "8081") url.port = new URL(api).port;
      super(url.href, protocols);
    }
  };
}

async function writeAntigravityFixture({ home, projectPath, parentId, subagentId }) {
  const parentLogs = join(home, ".gemini", "antigravity", "brain", parentId, ".system_generated", "logs");
  const subLogs = join(home, ".gemini", "antigravity", "brain", subagentId, ".system_generated", "logs");
  await mkdir(parentLogs, { recursive: true });
  await mkdir(subLogs, { recursive: true });

  const skillDir = join(projectPath, ".agents", "skills", "agy-deploy");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: agy-deploy\ndescription: Deploy application with Antigravity workflow\n---\nDeploy steps.\n",
    "utf-8",
  );

  const parentSteps = [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-11-06T10:00:00Z",
      content: "<USER_REQUEST>\nKiểm tra kiến trúc dự án và chạy subagent\n</USER_REQUEST>",
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-06T10:00:02Z",
      thinking: "Đang đọc cấu hình dự án và khởi chạy subagent nghiên cứu.",
      content: "",
      tool_calls: [
        {
          id: "call-read-1",
          name: "read_file",
          args: { Path: JSON.stringify(join(projectPath, "GEMINI.md")) },
        },
        {
          id: "call-sub-1",
          name: "invoke_subagent",
          args: {
            TypeName: '"research"',
            Role: '"Architecture Researcher"',
            Prompt: '"Audit Antigravity integration modules"',
          },
        },
      ],
    },
    {
      step_index: 2,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-11-06T10:00:03Z",
      content: "# Project Gemini Rules",
    },
    {
      step_index: 3,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-11-06T10:00:04Z",
      content: `Subagent launched with conversationId: ${subagentId}`,
    },
    {
      step_index: 4,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-06T10:00:08Z",
      content: "Đã hoàn tất kiểm tra tích hợp Antigravity trên PPM!",
    },
  ];

  const subSteps = [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-11-06T10:00:04Z",
      content: "<USER_REQUEST>\nAudit Antigravity integration modules\n</USER_REQUEST>",
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-06T10:00:05Z",
      thinking: "Subagent inspecting antigravity-provider.ts",
      content: "",
      tool_calls: [
        {
          id: "sub-read-1",
          name: "read_file",
          args: { Path: JSON.stringify(join(projectPath, "src/providers/antigravity/antigravity-provider.ts")) },
        },
      ],
    },
    {
      step_index: 2,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      created_at: "2026-11-06T10:00:06Z",
      content: "export class AntigravityProvider implements AIProvider {}",
    },
    {
      step_index: 3,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-06T10:00:07Z",
      content: "Subagent report: AntigravityProvider verified.",
    },
  ];

  const parentTranscriptPath = join(parentLogs, "transcript.jsonl");
  const subTranscriptPath = join(subLogs, "transcript.jsonl");
  await writeFile(parentTranscriptPath, parentSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf-8");
  await writeFile(subTranscriptPath, subSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf-8");

  return { parentTranscriptPath, subTranscriptPath };
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const harness = await createHtmlPreviewHarness({
    serverScript: "tests/e2e/fixtures/agent-session/agent-session-server.ts",
  });
  const home = join(harness.sandbox, "home");

  try {
    const created = await fetch(`${harness.api}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: harness.project, name: PROJECT }),
    });
    const createdBody = await created.json();
    assert.ok(createdBody.ok, `project registration failed: ${JSON.stringify(createdBody)}`);
    const projectPath = createdBody.data.path;

    const parentId = randomUUID();
    const subagentId = randomUUID();
    const { subTranscriptPath } = await writeAntigravityFixture({
      home,
      projectPath,
      parentId,
      subagentId,
    });

    const tab = {
      id: `chat-${parentId}`,
      type: "chat",
      title: "Antigravity Session",
      projectId: PROJECT,
      closable: true,
      metadata: { projectName: PROJECT, sessionId: parentId, providerId: "antigravity" },
    };
    const wsRes = await fetch(`${harness.api}/api/project/${PROJECT}/workspace`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        layout: {
          panels: { main: { id: "main", tabs: [tab], activeTabId: tab.id, tabHistory: [tab.id] } },
          grid: [["main"]],
          focusedPanelId: "main",
        },
      }),
    });
    assert.ok(wsRes.ok, `workspace setup failed: ${wsRes.status}`);

    const ctx = await harness.browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
    await ctx.addInitScript(pointWsAtFixture, { api: harness.api });
    const page = await ctx.newPage();

    await page.goto(`${harness.web}/project/${PROJECT}`);
    await page.locator('textarea[placeholder="Ask anything..."]:visible').first().waitFor({ timeout: 20_000 });

    await scenario("browser: renders Antigravity chat messages, Read tool card, and one-line Agent card", async () => {
      await page.waitForSelector(cardButtonSel, { timeout: 20_000 });
      const bodyText = await page.locator("body").innerText();
      assert.ok(
        bodyText.includes("Kiểm tra kiến trúc dự án và chạy subagent"),
        "missing cleaned user message in chat DOM",
      );
      assert.ok(
        bodyText.includes("Đã hoàn tất kiểm tra tích hợp Antigravity trên PPM!"),
        "missing assistant final message in chat DOM",
      );
      const rowText = await page.locator(cardButtonSel).first().innerText();
      assert.ok(
        rowText.includes("Architecture Researcher") || rowText.includes("Audit Antigravity integration modules"),
        `unexpected Agent card row text: ${rowText}`,
      );
      assert.ok(/\b1 step\b/.test(rowText), `expected '1 step' on Agent card, got: ${rowText}`);
      await page.screenshot({ path: join(SHOTS, "antigravity-01-chat-view.png") });
    });

    await scenario("browser: clicking Agent card opens live Antigravity subagent window over /ws/global", async () => {
      await page.locator(cardButtonSel).first().click();
      await page.waitForSelector(windowSel, { timeout: 10_000 });
      await page.waitForFunction(
        () => document.querySelector('[role="group"][aria-roledescription="window"]')?.innerText.includes("antigravity-provider.ts"),
        { timeout: 10_000 },
      );
      const winText = await page.locator(windowSel).first().innerText();
      assert.ok(winText.includes("antigravity-provider.ts"), `subagent window missing tool step: ${winText}`);
      assert.ok(!winText.includes("offline"), `subagent window should be live, not offline: ${winText}`);
      await page.screenshot({ path: join(SHOTS, "antigravity-02-subagent-window.png") });
    });

    await scenario("browser: live-appending a step to subagent transcript.jsonl updates window in real time", async () => {
      const liveStep = {
        step_index: 4,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: new Date().toISOString(),
        content: "",
        tool_calls: [
          {
            id: "sub-read-live",
            name: "read_file",
            args: { Path: JSON.stringify(join(projectPath, "src/providers/antigravity/live-stream-verified.ts")) },
          },
        ],
      };
      await appendFile(subTranscriptPath, JSON.stringify(liveStep) + "\n", "utf-8");
      await page.waitForFunction(
        () => document.querySelector('[role="group"][aria-roledescription="window"]')?.innerText.includes("live-stream-verified.ts"),
        { timeout: 5_000 },
      );
      await page.screenshot({ path: join(SHOTS, "antigravity-03-live-stream-update.png") });
    });

    await scenario("browser: typing / in chat composer discovers .agents/skills/agy-deploy", async () => {
      const textarea = page.locator('textarea[placeholder="Ask anything..."]:visible').first();
      await textarea.click();
      await textarea.fill("/agy");
      await page.waitForFunction(
        () => document.body.innerText.includes("agy-deploy"),
        { timeout: 10_000 },
      );
      await page.screenshot({ path: join(SHOTS, "antigravity-04-slash-skill-picker.png") });
    });

    await ctx.close();
  } finally {
    await harness.browser.close();
    await harness.cleanup();
  }

  const failed = results.filter((r) => !r.pass);
  log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
