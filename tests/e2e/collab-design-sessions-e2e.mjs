// An ordinary chat working with a Design chat, end to end, on the production Vite bundle against
// the session-collaboration fixture (tests/e2e/fixtures/session-collab-server.ts), whose scripted
// Claude calls the real `ppm-sessions` tools with the token PPM hands each turn:
//
//   D1  the chat asks to open a Design chat for the design "kho-task" (create_session with
//       `design`), the user allows it on the card, the new chat is a Design chat (its turn runs
//       with the design instructions) and its answer comes back as the reply;
//   D2  a follow-up with send_to_session and wait: the Design chat's answer is again the reply;
//   D3  design_screenshot renders both variants to PNG with a real Chromium, served by id (the
//       fixture runs with auth off; the route is behind the login in a real PPM);
//   D4–D7 the same Design chat seen from the Design tab the user opens from the sidebar
//       (fixtures/collab-design-sessions-steps-tab.mjs), on a desktop and a phone.
//
// Run it in the capped e2e image (Chromium, Node 20 and playwright-core; see tests/e2e/docker/):
//
//   docker run --rm --cpus=2 --memory=4g -v <repo>:/app:ro -v ppm-e2e-nm:/app/node_modules \
//     -v <out>:/out -v <scratch-web>:/web -w /app -e IS_SANDBOX=1 \
//     -e PPM_COLLAB_ARTIFACTS=/out -e PPM_COLLAB_WEB_DIR=/web ppm-e2e-chromium:latest \
//     sh -c 'bun install --frozen-lockfile && node tests/e2e/collab-design-sessions-e2e.mjs'
//
// PPM_HEADLESS_BROWSER defaults to PPM_PLAYWRIGHT_EXECUTABLE, so the screenshots use the image's
// Chromium. The screenshots and the PNGs land in PPM_COLLAB_ARTIFACTS.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { createKit, pageInit } from "./fixtures/session-turn-refs-helpers.mjs";
import { collabKit, resultOf } from "./fixtures/session-collab-helpers.mjs";
import { runDesignTabSteps } from "./fixtures/collab-design-sessions-steps-tab.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-collab-design-e2e-"));
const artifacts = process.env.PPM_COLLAB_ARTIFACTS ? resolve(process.env.PPM_COLLAB_ARTIFACTS) : join(sandbox, "artifacts");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), projects = join(sandbox, "projects");
await Promise.all([artifacts, ppm, home, projects].map((p) => mkdir(p, { recursive: true })));

async function command(cmd, args) {
  const child = spawn(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (s) => log += s); child.stderr.on("data", (s) => log += s);
  const code = await new Promise((done, reject) => { child.on("exit", done); child.on("error", reject); });
  if (code) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${log}`);
  return log;
}

const webDir = process.env.PPM_COLLAB_WEB_DIR ? resolve(process.env.PPM_COLLAB_WEB_DIR) : join(sandbox, "web");
if (!existsSync(join(webDir, "index.html"))) {
  await writeFile(join(artifacts, "vite.log"), await command("bun", ["node_modules/vite/bin/vite.js", "build", "--outDir", webDir]));
}

const listener = createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise((r) => listener.close(r));
const web = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(port),
  PPM_COLLAB_WEB_DIR: webDir, PPM_COLLAB_PROJECTS: projects,
  ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE && !process.env.PPM_HEADLESS_BROWSER ? { PPM_HEADLESS_BROWSER: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
};
delete env.PPM_ALLOW_PROD_DB;
const backend = spawn("bun", ["tests/e2e/fixtures/session-collab-server.ts"], { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
let serverLog = ""; backend.stdout.on("data", (s) => serverLog += s); backend.stderr.on("data", (s) => serverLog += s);

const page = (bg, words, buttonPx = 14) => `<!doctype html><html><head><meta charset="utf-8"><title>${words}</title></head>`
  + `<body style="margin:0;font-family:sans-serif;background:${bg};color:#fff">`
  + `<header style="padding:32px 48px;font-size:36px;font-weight:700">Kho task — ${words} `
  + `<button style="font-size:${buttonPx}px;padding:${buttonPx / 2}px ${buttonPx}px;border-radius:8px;border:0">Add task</button></header>`
  + `<main style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:0 48px 48px">`
  + ["Inbox", "Doing", "Done"].map((c) => `<section style="background:rgba(255,255,255,.12);border-radius:12px;padding:20px;min-height:420px">`
    + `<h2 style="margin:0 0 12px">${c}</h2><p>Task A</p><p>Task B</p></section>`).join("")
  + `</main></body></html>`;

let browser;
const ctx = { current: null };
const kit = createKit({ web, artifacts, currentPage: () => ctx.current });
const ck = collabKit(kit, web);
const { until, results, failures } = kit;
const started = Date.now();
const jsonOf = (text) => JSON.parse(text.slice(0, text.lastIndexOf("}") + 1));

try {
  await until("fixture healthy", async () => (await fetch(`${web}/api/health`)).ok, 90000, 300);
  const { alpha } = await ck.route("/project");
  // An existing design of the project, as `ppm design create` and a Design chat leave it.
  const designDir = join(alpha, "designs", "kho-task");
  await mkdir(designDir, { recursive: true });
  await writeFile(join(designDir, "design.json"), JSON.stringify({
    title: "Kho task", kind: "page", entry: "index.html",
    variants: [{ file: "index.html", label: "Light" }, { file: "variant-2.html", label: "Dark" }],
  }));
  await writeFile(join(designDir, "index.html"), page("#2563eb", "Light"));
  await writeFile(join(designDir, "variant-2.html"), page("#111827", "Dark"));
  await kit.post("/api/projects", { name: "alpha", path: alpha });
  const A = await ck.newSession("claude", "Planner");

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  const executablePath = process.env.PPM_PLAYWRIGHT_EXECUTABLE;
  const channel = process.env.PPM_PLAYWRIGHT_CHANNEL;
  browser = await pw.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : channel ? { channel } : {}) });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await desktop.addInitScript(pageInit);
  const tab = ctx.current = await desktop.newPage();
  await tab.goto(`${web}/project/alpha`);

  let child = null;

  await kit.scenario("D1", async () => {
    await ck.plan(A.id, ck.steps(
      { call: "create_session", args: { title: "Kho task UI", task: "Build two variants of the Kho task board, then tell me the files.", design: "kho-task", wait: true } },
      { say: "The Design chat answered." },
    ));
    await ck.plan("title:Kho task UI", ck.steps({ say: "Built index.html (Light) and variant-2.html (Dark)." }));
    const from = (await ck.calls()).length;
    await ck.show(tab, [A]);
    await ck.send(tab, "Open a Design chat for kho-task and have it build two variants.");
    const card = tab.locator('[data-collab-approval="create"]:visible');
    await card.waitFor({ timeout: 20000 });
    const cardText = await card.innerText();
    assert.match(cardText, /Design chat for Kho task/);
    assert.match(cardText, /designs\/kho-task/);
    await kit.shot(tab, "d1a-create-design-card");
    await card.getByRole("button", { name: "Allow once" }).click();
    const [call] = await ck.answered(from, 1, (c) => c.tool === "create_session", 60000);
    const body = resultOf(call);
    assert.ok(body, `create_session answered: ${call.text}`);
    assert.equal(body.design, "kho-task");
    assert.equal(body.reply?.replied, true, `the Design chat's answer is the reply: ${call.text}`);
    assert.match(body.reply.text, /variant-2\.html/);
    child = body.sessionId;
    const slug = await kit.api(`/api/project/alpha/chat/sessions/${child}/design`);
    assert.equal(slug.data.designSlug, "kho-task", "the new chat is a Design chat of kho-task");
    const turn = (await ck.sends()).find((s) => s.sessionId === child && s.kind === "turn");
    assert.equal(turn?.design, true, "its turn ran with the design instructions");
    assert.equal(turn?.replyVia, "answer", "it was told to answer in its reply");
    await kit.until("A's turn ended", async () => (await ck.live(A.id))?.phase === "idle", 30000, 200);
    await kit.shot(tab, "d1b-design-chat-replied");
    kit.record("D1: create_session with design opens a Design chat behind the card; its answer is the reply", { reply: body.reply.text });
  });

  await kit.scenario("D2", async () => {
    assert.ok(child, "D1 created the Design chat");
    await ck.plan(A.id, ck.steps(
      { call: "send_to_session", args: { session_id: child, message: "Make variant 2 darker and say what changed.", wait: true } },
      { say: "Variant 2 is darker now." },
    ));
    await ck.plan(child, ck.steps({ say: "variant-2.html: background is now #0b1120, cards 8% lighter." }));
    const from = (await ck.calls()).length;
    await ck.send(tab, "Ask the Design chat to darken variant 2.");
    const [call] = await ck.answered(from, 1, (c) => c.tool === "send_to_session", 60000);
    const body = resultOf(call);
    assert.equal(body?.reply?.replied, true, `send_to_session got the answer: ${call.text}`);
    assert.match(body.reply.text, /#0b1120/);
    await kit.until("A's turn ended", async () => (await ck.live(A.id))?.phase === "idle", 30000, 200);
    await kit.shot(tab, "d2-send-to-design-chat");
    kit.record("D2: send_to_session with wait reaches the Design chat and returns its answer", { reply: body.reply.text });
  });

  await kit.scenario("D3", async () => {
    await ck.plan(A.id, ck.steps(
      { call: "design_screenshot", args: { design: "kho-task" } },
      { say: "Here are both variants." },
    ));
    const from = (await ck.calls()).length;
    await ck.send(tab, "Show me both variants.");
    const [call] = await ck.answered(from, 1, (c) => c.tool === "design_screenshot", 90000);
    assert.equal(call.isError, false, `design_screenshot: ${call.text}`);
    const { shots } = jsonOf(call.text);
    assert.deepEqual(shots.map((s) => s.file), ["index.html", "variant-2.html"]);
    for (const shot of shots) {
      const res = await fetch(`${web}/api/design-shots/${shot.id}.png`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      const bytes = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
      await writeFile(join(artifacts, `d3-${shot.file.replace(/\W+/g, "-")}.png`), bytes);
    }
    await kit.until("A's turn ended", async () => (await ck.live(A.id))?.phase === "idle", 30000, 200);
    await kit.shot(tab, "d3-design-screenshot-card");
    kit.record("D3: design_screenshot renders both variants to PNG, served by id", { shots: shots.map((s) => `${s.file} ${s.width}x${s.height}`) });
  });

  await runDesignTabSteps({ kit, ck, page: tab, browser, web, A, child, pageHtml: page, pageInit, artifacts });

  if (failures.length) {
    process.exitCode = 1;
    console.log(`FAILED scenarios: ${failures.map((f) => f.scenario).join(", ")}`);
  }
} catch (error) {
  console.error(`FAIL ${error.stack ?? error}`);
  process.exitCode = 1;
  try { await ctx.current?.screenshot({ path: join(artifacts, "failure.png") }); } catch { /* page gone */ }
} finally {
  await browser?.close();
  backend.kill();
  await writeFile(join(artifacts, "server.log"), serverLog);
  await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  console.log(`${results.filter((r) => r.passed).length} passed, ${failures.length} failed in ${Math.round((Date.now() - started) / 1000)} s; artifacts in ${artifacts}`);
}
