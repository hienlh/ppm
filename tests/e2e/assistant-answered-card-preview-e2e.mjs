// A folded answered card shows the start of the user's reply and of the manager's answer, so it
// can be read without opening. End to end on the manager-loop fixture: a manager files a card, the
// user replies in PPM, the scripted manager answers in Markdown, and the card that folds in the
// Assistant's stream carries both as plain text — the answer two lines at most — on a 1440 px
// desktop and a 390 px phone. A second card answered with a new card names that card instead; a
// third, answered with OK, shows no preview. Every control in the photographed area is measured
// against docs/design-guidelines.md rule 3 (text buttons 28/26 px, icon buttons 24/22, no 44 px).
//
// Sample data only (no client, payroll or tax details). Run in the capped e2e image:
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco> PPM_ANSWERED_PREVIEW_SHOTS=<dir> node tests/e2e/assistant-answered-card-preview-e2e.mjs
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild, until } from "./assistant-telegram/harness.mjs";
import { loopKit } from "./assistant-manager-loop/loop-kit.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-answered-preview-e2e-"));
const shotsDir = resolve(process.env.PPM_ANSWERED_PREVIEW_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppmHome = join(sandbox, "ppm-home"), home = join(sandbox, "home"), projDir = join(sandbox, "demo");
await Promise.all([shotsDir, logs, ppmHome, home, projDir].map((p) => mkdir(p, { recursive: true })));
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);
await writeFile(join(projDir, "README.md"), "# demo\n");
const git = (...args) => execFileSync("git", args, { cwd: projDir, stdio: "pipe" });
git("init", "-q");
git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "add", ".");
git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "-m", "init");

const RELEASE = { kind: "needs_decision", title: "REL-204: release 0.27 is ready — merge when CI is green?", body: "Changelog written, version bumped. Waiting for your go." };
const LOGS = { kind: "needs_decision", title: "DEMO-31: clean old logs on the staging box?", body: "Disk is at 91%." };
const BACKUP = { kind: "needs_decision", title: "DEMO-17: move the nightly backup to 02:00?", body: "The 23:00 run overlaps the import." };
const LOGS_NEW = { kind: "needs_decision", title: "DEMO-31: delete 12 GB of logs, keep error logs?", body: "Error logs are 300 MB; the rest are info logs older than 30 days." };

const RELEASE_REPLY = "Merge được chưa em? CI **xanh** hết chưa?";
const RELEASE_ANSWER = [
  "## Đã kiểm tra",
  "",
  "- CI **xanh** cả 3 job (unit, e2e, build).",
  "- `bun test` → 2.900 pass, 0 fail.",
  "",
  "Em merge ngay và gắn tag `v0.27.0`, báo anh khi xong. Ghi chú phát hành ở [PR #88](https://example.invalid/pr/88); "
    + "phần thay đổi lớn nhất là bộ đệm phiên mới, đã đo lại trên máy thử và nhanh hơn khoảng 30% so với bản trước.",
].join("\n");
const RELEASE_PLAIN_START = "Đã kiểm tra CI xanh cả 3 job (unit, e2e, build). bun test → 2.900 pass, 0 fail. Em merge ngay";
const LOGS_REPLY = "Xoá hết log cũ hơn 30 ngày nhé";

const OWNER = 1001;
const checks = [];
const ok = (name) => { checks.push(name); console.log(`PASS ${name}`); };
let fake, backend, browser, web, failure = null;

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}
const onboardingDone = () => {
  if (window.top !== window) return;
  localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
};

/** The folded rows and every control drawn in the stream, measured as the user sees them. */
const measure = (body) => body.evaluate((root) => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
  const rows = [...root.querySelectorAll("[data-answered-card]")].map((card) => {
    const toggle = card.querySelector("[data-answered-toggle]");
    const answer = card.querySelector("[data-answered-answer]");
    const reply = card.querySelector("[data-answered-reply]");
    const cs = answer ? getComputedStyle(answer) : null;
    return {
      title: card.querySelector("[data-answered-title]")?.textContent ?? "",
      open: card.hasAttribute("data-answered-open"),
      row: toggle ? box(toggle) : null,
      rowMinHeight: toggle ? getComputedStyle(toggle).minHeight : null,
      reply: reply?.textContent ?? null,
      replyNoWrap: reply ? getComputedStyle(reply).whiteSpace : null,
      answer: answer?.textContent ?? null,
      answerClamp: cs ? cs.webkitLineClamp : null,
      answerLines: cs ? Math.round(answer.getBoundingClientRect().height / parseFloat(cs.lineHeight)) : null,
      answerFontPx: cs ? parseFloat(cs.fontSize) : null,
      answerColor: cs ? cs.color : null,
    };
  });
  // Every real control inside an answered card (the fold row itself is a list row: rule 3 leaves it to its content).
  const controls = [...root.querySelectorAll("[data-answered-card] button:not([data-answered-toggle]), [data-answered-card] a[role=button]")]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => ({ text: (el.textContent ?? "").trim().slice(0, 30), ...box(el), minHeight: getComputedStyle(el).minHeight }));
  return { rows, controls };
});

try {
  const f = startChild("bun", ["tests/e2e/fixtures/fake-telegram-server.ts"], { env: { ...process.env }, log: join(logs, "fake-telegram.log"), ready: /FAKE_TELEGRAM (\{.*\})/ });
  fake = f.child;
  const fakeInfo = JSON.parse((await f.ready)[1]);
  const port = await freePort();
  web = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PPM_HOME: ppmHome, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
    PPM_HTML_TEST_PORT: String(port), PPM_ASSISTANT_WEB_DIR: webDir,
    PPM_ASSISTANT_FIXTURE_STATE: join(sandbox, "scripted-provider-state.json"),
    PPM_ASSISTANT_APPROVAL_TIMEOUT_MS: "600000",
    PPM_ASSISTANT_MANAGER_LOOP: "1",
    PPM_ASSISTANT_FAKE_TELEGRAM: "1", PPM_TELEGRAM_API_BASE: fakeInfo.api, PPM_ASSISTANT_FAKE_TELEGRAM_TOKEN: fakeInfo.token,
    PPM_ASSISTANT_FAKE_TELEGRAM_CHATS: JSON.stringify([[String(OWNER), String(OWNER), "Phone"]]),
    PPM_ASSISTANT_FAKE_TELEGRAM_DEBOUNCE_MS: "200", PPM_ASSISTANT_FIXTURE_TG_DELAY_SCALE: "0.05",
  };
  delete env.PPM_ALLOW_PROD_DB;
  delete env.PPM_ASSISTANT_FIXTURE_RESUME;
  const b = startChild("bun", ["tests/e2e/fixtures/assistant-server.ts"], { env, log: join(logs, "fixture.log"), ready: /Assistant fixture ready/ });
  backend = b.child;
  await b.ready;
  console.log(`fixture server pid=${backend.pid} port=${port}; fake telegram pid=${fake.pid}`);
  const fx = fixtureApi(web);
  await fx.post("/api/projects", { name: "Demo", path: projDir });
  await until("bridge running", async () => (await fx.tg("bridge")).running, 30000);
  const main = (await fx.post("/api/project/__assistant__/chat/sessions", { providerId: "claude", title: "Assistant" })).data.id;
  await fx.post("/api/assistant/telegram/bind", { sessionId: main, chatId: String(OWNER) });
  const { data: { settings } } = await fx.api("/api/assistant/settings");
  await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...settings, timezone: "UTC", digest: { enabled: false, time: "08:00" } }) });

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true, args: ["--disable-dev-shm-usage"],
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
    ...(process.env.PPM_PLAYWRIGHT_CHANNEL ? { channel: process.env.PPM_PLAYWRIGHT_CHANNEL } : {}),
  });
  const desk = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await desk.addInitScript(onboardingDone);
  const page = await desk.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
  const tg = phone(fakeInfo.control);
  const k = loopKit({ web, fx, tg, page, shotsDir, owner: OWNER, record: () => {} });

  // ---- A manager files three cards ----
  const manager = (await fx.post("/api/project/Demo/chat/sessions", { providerId: "claude", title: "Manager" })).data.id;
  await k.managerTurn("Demo", manager, "seed", [], "Keep the plan", "default");
  await k.idle(manager);
  await fx.api("/api/assistant/managers/Demo", { method: "PUT", body: JSON.stringify({ sessionId: manager }) });
  const file = async (label, card) => {
    await k.managerTurn("Demo", manager, label, [{ session: "report_to_assistant", args: card }], `File ${label}`, "default");
    const [r] = await k.answered(label, 1);
    assert.equal(r.isError, false, r.text);
    await k.idle(manager);
    return k.cardOf("needs_decision", card.title);
  };
  const backup = await file("c-backup", BACKUP);
  const logsCard = await file("c-logs", LOGS);
  const release = await file("c-release", RELEASE);
  ok("three sample cards are open");

  /** The user's reply in PPM, the manager's scripted answer to it, and the follow-up kept on the card. */
  async function replyAndAnswer(card, label, reply, answer, ops = []) {
    await k.script(label, ops, { match: reply, sessionId: manager, reply: answer });
    const res = await fx.post(`/api/assistant/cards/${card.id}/reply`, { text: reply });
    assert.ok(res.ok !== false && !res.error, `reply sent: ${JSON.stringify(res).slice(0, 200)}`);
    await until(`${label} ran`, () => fx.turnOf(label), 30000);
    await k.idle(manager);
    // A provider that names no turn is judged after a short grace on the Assistant's clock.
    await k.advance(3_500);
    return until(`${label}: follow-up kept`, async () => (await k.cards()).find((c) => c.id === card.id)?.followUp, 30000);
  }
  const relFollow = await replyAndAnswer(release, "a-release", RELEASE_REPLY, RELEASE_ANSWER);
  assert.equal(relFollow.reply, "Merge được chưa em? CI xanh hết chưa?", "the reply is kept as plain text");
  assert.ok(relFollow.text.includes("**xanh**"), "the answer itself is kept whole, as Markdown");
  ok("the reply is kept with the manager's answer, as plain text; the answer stays Markdown");
  const logsFollow = await replyAndAnswer(logsCard, "a-logs", LOGS_REPLY, "Em mở card mới để anh chốt.",
    [{ session: "report_to_assistant", args: LOGS_NEW }]);
  assert.deepEqual(logsFollow.newCards?.map((c) => c.title), [LOGS_NEW.title], "the new card is the answer");
  await fx.post(`/api/assistant/cards/${backup.id}/ok`, {});
  await until("backup card answered", async () => (await k.cards()).find((c) => c.id === backup.id)?.status === "answered", 30000);
  await k.idle(manager);
  ok("one card answered in words, one with a new card, one with OK");

  // ---- Desktop 1440 ----
  async function folded(pg, kit, name) {
    await pg.goto(`${web}/project/Demo/assistant`);
    const body = kit.body();
    await body.locator("[data-answered-preview]").first().waitFor({ timeout: 30000 });
    const rel = body.locator("[data-answered-card]", { hasText: "REL-204" });
    await rel.scrollIntoViewIfNeeded();
    await pg.waitForTimeout(500);
    await pg.screenshot({ path: join(shotsDir, `${name}-folded.png`) });
    const seen = await measure(body);
    const relRow = seen.rows.find((r) => r.title.startsWith("REL-204"));
    const logsRow = seen.rows.find((r) => r.title === LOGS.title);
    const backupRow = seen.rows.find((r) => r.title === BACKUP.title);
    assert.ok(relRow && logsRow && backupRow, `all three folded: ${seen.rows.map((r) => r.title).join(" | ")}`);
    assert.equal(relRow.reply, "You: Merge được chưa em? CI xanh hết chưa?");
    assert.ok(relRow.answer.startsWith(`Manager: ${RELEASE_PLAIN_START}`), relRow.answer);
    for (const mark of ["**", "`", "##", "](", "- "]) assert.ok(!relRow.answer.includes(mark), `no Markdown "${mark}" in ${relRow.answer}`);
    assert.equal(String(relRow.answerClamp), "2", "the answer is clamped to two lines");
    assert.ok(relRow.answerLines <= 2, `drawn on at most two lines (${relRow.answerLines})`);
    assert.equal(relRow.answerFontPx, 12, "small text");
    assert.equal(relRow.replyNoWrap, "nowrap", "the reply is one line");
    assert.equal(logsRow.answer, `Manager: New card: “${LOGS_NEW.title}”`);
    assert.equal(logsRow.reply, `You: ${LOGS_REPLY}`);
    assert.equal(backupRow.reply, null);
    assert.equal(backupRow.answer, null);
    for (const r of seen.rows) assert.notEqual(r.rowMinHeight, "44px", `${r.title}: no 44 px minimum`);
    return { body, rel, seen };
  }
  async function opened(pg, body, rel, name, phoneSize) {
    await rel.locator("[data-answered-toggle]").click();
    await rel.locator("[data-card-followup]").waitFor({ timeout: 5000 });
    await pg.waitForTimeout(500);
    await pg.screenshot({ path: join(shotsDir, `${name}-opened.png`) });
    const seen = await measure(body);
    const relRow = seen.rows.find((r) => r.title.startsWith("REL-204"));
    assert.equal(relRow.answer, null, "opened, the card shows the answer whole and no preview");
    const followup = await rel.locator("[data-card-followup]").innerText();
    assert.ok(followup.includes("v0.27.0"), "the whole answer is under the opened card");
    const want = phoneSize ? 26 : 28;
    for (const c of seen.controls) {
      assert.notEqual(c.minHeight, "44px", `${c.text}: no 44 px minimum`);
      assert.ok(c.h <= want + 0.5, `${c.text}: ${c.h}px tall, at most ${want}px`);
    }
    await rel.locator("[data-answered-toggle]").click();
    return seen;
  }
  const deskFolded = await folded(page, k, "01-desktop-1440");
  ok("desktop: folded cards show the reply (one line) and the answer (two lines, plain text); OK shows none");
  const deskOpened = await opened(page, deskFolded.body, deskFolded.rel, "02-desktop-1440", false);
  ok("desktop: opened, the answer is whole and every control in the card is at most 28 px");

  // ---- Phone 390 ----
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await phoneCtx.addInitScript(onboardingDone);
  const mob = await phoneCtx.newPage();
  mob.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
  const mk = loopKit({ web, fx, tg, page: mob, shotsDir, owner: OWNER, record: () => {} });
  const mobFolded = await folded(mob, mk, "03-phone-390");
  ok("phone: the same preview, clamped to two lines");
  const mobOpened = await opened(mob, mobFolded.body, mobFolded.rel, "04-phone-390", true);
  ok("phone: opened, every control in the card is at most 26 px");

  await writeFile(join(shotsDir, "measurements.json"), JSON.stringify({
    desktop: { folded: deskFolded.seen, opened: deskOpened }, phone: { folded: mobFolded.seen, opened: mobOpened },
  }, null, 2));
  assert.deepEqual(pageErrors, [], pageErrors.join("\n"));
  ok("no page errors");
} catch (e) {
  failure = e;
} finally {
  await browser?.close().catch(() => {});
  backend?.kill("SIGTERM");
  fake?.kill("SIGTERM");
}
console.log(`\n${checks.length} checks passed; shots in ${shotsDir}; logs in ${logs}`);
if (failure) {
  console.error(`FAIL ${failure.stack ?? failure}`);
  process.exit(1);
}
