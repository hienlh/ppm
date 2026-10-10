// Shared plumbing for tests/e2e/assistant-telegram-e2e.mjs: the fixture and the fake Telegram as
// child processes, the scripted provider's test routes, a phone played through the fake's control
// API, browser devices, screenshots and one transcript of the fake Telegram chats per scenario.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(label, fn, timeout = 30000, every = 100) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(every);
  }
  throw new Error(`Timeout: ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 400)})`);
}

/** Starts a child whose output goes to a bounded log file; resolves once `ready` matches a line. */
export function startChild(cmd, args, { env, log, ready, cwd = process.cwd() }) {
  const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  const out = createWriteStream(log, { flags: "a" });
  let written = 0;
  let buffer = "";
  const LOG_MAX = 20 * 1024 * 1024;
  const readyLine = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const s = String(chunk);
      if (written < LOG_MAX) { out.write(s); written += s.length; }
      buffer = (buffer + s).slice(-20000);
      const m = ready && buffer.split("\n").map((l) => l.match(ready)).find(Boolean);
      if (m) resolve(m);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`${cmd} ${args.join(" ")} exited ${code} before it was ready; see ${log}`)));
    child.on("error", reject);
  });
  child.on("exit", () => out.end());
  return { child, ready: readyLine };
}

/** The scripted fixture's test routes and PPM's own API, on `web`. */
export function fixtureApi(web) {
  const call = async (path, init = {}) => {
    const response = await fetch(web + path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: response.ok, status: response.status, body };
  };
  const api = async (path, init = {}) => {
    const r = await call(path, init);
    assert(r.ok, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const state = () => api("/__assistant-test/calls");
  return {
    call, api, state,
    tg: (route, init) => api(`/__assistant-test/tg/${route}`, init),
    post: (path, body) => api(path, { method: "POST", body: JSON.stringify(body) }),
    /** Queues the ops of a turn: on `sessionId`, on the first turn whose message has `match`, or the next turn. */
    script: (label, ops, { sessionId, match } = {}) => api("/__assistant-test/script", {
      method: "POST", body: JSON.stringify({ label, ops, ...(sessionId ? { sessionId } : {}), ...(match ? { match } : {}) }),
    }),
    turnsOf: async (label) => (await state()).turns.filter((t) => t.label === label),
    turnOf: async (label) => (await state()).turns.find((t) => t.label === label),
    recordsOf: async (label) => (await state()).calls.filter((c) => c.label === label),
  };
}

/** The person on the phone, through the fake Telegram's control API. */
export function phone(control) {
  const post = async (path, body) => {
    const r = await fetch(control + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await r.json();
    if (!r.ok) throw new Error(`fake Telegram ${path}: ${json.error ?? r.status}`);
    return json;
  };
  const get = async (path) => (await fetch(control + path)).json();
  const tg = {
    send: (chatId, text, { userId = chatId, chatType, extra } = {}) => post("/push", { chatId, userId, text, chatType, extra }),
    photo: (chatId, caption, { userId = chatId } = {}) => post("/photo", { chatId, userId, caption }),
    press: (chatId, messageId, data, { userId = chatId, stale = false } = {}) => post("/press", { chatId, userId, messageId, data, stale }),
    fail: (method, failure) => post("/fail", { method, failure }),
    chat: (chatId) => get(`/chat?id=${chatId}`),
    sent: async (chatId) => (await tg.chat(chatId)).sent,
    answers: () => get("/answers"),
    calls: (from = 0) => get(`/calls?from=${from}`),
    commands: () => get("/commands"),
    exit: () => post("/exit", {}).catch(() => {}),
    /** The newest message of the chat that satisfies `pred`. */
    async waitFor(chatId, label, pred, timeout = 30000) {
      return until(`telegram ${chatId}: ${label}`, async () => (await tg.sent(chatId)).findLast(pred), timeout);
    },
    waitText: (chatId, part, timeout = 30000) => tg.waitFor(chatId, JSON.stringify(part), (m) => m.text.includes(part), timeout),
    /** Presses the button labelled `text` under `message`. */
    async pressLabel(chatId, message, text, opts = {}) {
      const button = buttonsOf(message).find((b) => b.text === text || b.text.endsWith(text));
      assert(button?.callback_data, `message ${message.message_id} in ${chatId} has a "${text}" button (has: ${buttonsOf(message).map((b) => b.text).join(", ")})`);
      await tg.press(chatId, message.message_id, button.callback_data, opts);
      return button.callback_data;
    },
    /** The latest answer to a button press, once it arrived after `count` earlier ones. */
    async answerAfter(count, timeout = 15000) {
      return until("callback answered", async () => (await tg.answers())[count], timeout);
    },
    async message(chatId, messageId) {
      return (await tg.sent(chatId)).find((m) => m.message_id === messageId);
    },
  };
  return tg;
}

export const buttonsOf = (m) => m?.reply_markup?.inline_keyboard?.flat() ?? [];
export const labelsOf = (m) => buttonsOf(m).map((b) => b.text);

/** Writes the fake Telegram chats a scenario used as it stands: every message, edit count, buttons, deletions. */
export async function transcript(dir, id, tg, chatIds, startedAt) {
  const lines = [`# Fake Telegram transcript — scenario ${id}`, `# written ${new Date().toISOString()}`, ""];
  for (const chatId of chatIds) {
    const { sent, deleted } = await tg.chat(chatId);
    lines.push(`## chat ${chatId}  (${sent.length} messages now, ${deleted.length} deleted)`, "");
    for (const m of sent) {
      const buttons = labelsOf(m);
      lines.push(`[#${m.message_id}]${m.history.length ? ` (edited ${m.history.length}x)` : ""}`);
      lines.push(...m.text.split("\n").map((l) => `  ${l}`));
      if (buttons.length) lines.push(`  buttons: ${buttons.map((b) => `[${b}]`).join(" ")}`);
      lines.push("");
    }
    for (const m of deleted) lines.push(`[#${m.message_id} DELETED] ${m.text.split("\n")[0].slice(0, 200)}`);
    lines.push("");
  }
  const answers = await tg.answers();
  if (answers.length) lines.push("## button toasts (all scenarios so far)", ...answers.map((a, i) => `${i + 1}. ${a.text ?? "(none)"}`));
  await writeFile(join(dir, `telegram-${id}.txt`), `${lines.join("\n")}\n`);
  void startedAt;
}

// ------------------------------------------------------------------ browser
const COMPOSER = ["Ask anything...", "Follow-up...", "Follow-up or Stop..."].map((p) => `textarea[placeholder="${p}"]:visible`).join(", ");
const ASSISTANT_BODY = '[class*="@container/assistant"]';

export function browserKit({ web, shotsDir, browser }) {
  const devices = {};
  const chatRoot = (dev) => (dev.plain ? dev.page.locator("body") : dev.page.locator(`${ASSISTANT_BODY}:visible`).first());
  const kit = {
    devices,
    chatRoot,
    composer: (dev) => chatRoot(dev).locator(COMPOSER).first(),
    card: (dev) => chatRoot(dev).locator("[data-approval-request]:visible").last(),
    async open(name, kind) {
      const context = await browser.newContext(kind === "phone"
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" }
        : { viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
      await context.addInitScript(() => {
        if (window.top !== window) return;
        localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
      });
      const page = await context.newPage();
      const dev = { name, kind, context, page, errors: [], shots: [], plain: false };
      page.on("pageerror", (e) => dev.errors.push(`${e}\n${e.stack ?? ""}`));
      devices[name] = dev;
      return dev;
    },
    async shot(dev, name) {
      const path = join(shotsDir, `${dev.name}-${name}.png`);
      await dev.page.screenshot({ path });
      dev.shots.push(path);
      return path;
    },
    async openAssistant(dev, project = "alpha") {
      dev.plain = false;
      await dev.page.goto(`${web}/project/${project}/assistant`);
      await kit.composer(dev).waitFor({ timeout: 30000 });
    },
    /** A deep link `/assistant?session=<provider>/<id>`, as Telegram's "Open in PPM" gives it. */
    async openLink(dev, url) {
      dev.plain = false;
      await dev.page.goto(url);
      await kit.composer(dev).waitFor({ timeout: 30000 });
    },
    /** A project's ordinary chat, open in the page itself (`provider/id`, as PPM's own links name it). */
    async openChat(dev, project, sessionId, provider = "claude") {
      dev.plain = true;
      await dev.page.goto(`${web}/project/${project}?openChat=${encodeURIComponent(`${provider}/${sessionId}`)}`);
      await kit.composer(dev).waitFor({ timeout: 30000 });
    },
    /** The Assistant's session list: a sidebar on a wide window, a sheet on a phone. */
    async sessionsPane(dev) {
      if (await dev.page.locator('aside:visible button[aria-label^="New Assistant session"]').count()) return dev.page.locator("aside:visible");
      const sheetOpen = await dev.page.locator('ul[aria-label="Assistant sessions"]:visible').count();
      if (!sheetOpen) await dev.page.locator('button[aria-label="Assistant sessions"]:visible').click();
      await dev.page.locator('button[aria-label^="New Assistant session"]:visible').first().waitFor();
      return dev.page;
    },
    sessionRow: (pane, title) => pane.locator('ul[aria-label="Assistant sessions"] button:visible', { hasText: title }).first(),
    async closeSheet(dev) {
      if (dev.kind === "phone") await dev.page.keyboard.press("Escape");
    },
    /** Desktop: the status bar's window list → "Minimize all", so a floating window covers nothing. */
    async minimizeWindows(dev) {
      if (dev.kind !== "desktop") return;
      const windows = dev.page.locator('button[aria-label="Windows"]:visible');
      if (!(await windows.count())) return;
      await windows.first().click();
      const all = dev.page.getByText("Minimize all", { exact: true });
      if (await all.count()) await all.first().click();
      await dev.page.keyboard.press("Escape");
    },
    async typeAndSend(dev, text) {
      const box = kit.composer(dev);
      await box.waitFor({ timeout: 30000 });
      await box.fill(text);
      await box.press("Enter");
    },
  };
  return kit;
}
