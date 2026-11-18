// "Waiting on you" in the PPM Assistant, end to end at three sizes (1440 desktop, an 800 px
// floating window, a 390 px phone, and 320 for overflow). The waiting decisions are answered
// together in one set drawn whole as the stream's last item, each keeping a one-line stub at its
// own place; one "Waiting" chip in the chat footer's context row counts them and jumps to the set,
// on that card's tab. A decision the user already answered folds to one line that opens it again,
// read-only. A manager chat shows its own decisions as a set in its bar. Then: one card sent on
// its own, the rest through the review of "Send all" (an OK and a reply carrying a picture), and
// a Telegram photo reply to the last one, after which the chip, the set and every red count are gone.
//
// The cards: a long Markdown decision, one offering three choices, one carrying two design
// screenshots, an urgent one, and two already settled (one answered with a choice, one dismissed).
//
// Same disposable fixture as the manager loop (tests/e2e/fixtures/assistant-server.ts with
// PPM_ASSISTANT_MANAGER_LOOP=1 and a fake Telegram): no real model, no real PPM data.
//
//   PPM_ASSISTANT_WEB_DIR=<web build with Monaco staged> PPM_WAITING_SHOTS=<dir> node tests/e2e/assistant-waiting-cards-e2e.mjs
//
// Playwright comes from PPM_PLAYWRIGHT_MODULE (preset in the ppm-e2e-chromium image).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild, until } from "./assistant-telegram/harness.mjs";
import { loopKit } from "./assistant-manager-loop/loop-kit.mjs";
import { step1 } from "./assistant-manager-loop/steps-managers.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "ppm-waiting-cards-e2e-"));
const shotsDir = resolve(process.env.PPM_WAITING_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const alpha = join(sandbox, "alpha"), beta = join(sandbox, "beta");
await Promise.all([shotsDir, logs, ppm, home, alpha, beta].map((p) => mkdir(p, { recursive: true })));
for (const name of readdirSync(shotsDir)) if (name.endsWith(".png")) rmSync(join(shotsDir, name), { force: true });
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web build with Monaco at ${webDir}`);

for (const [dir, name] of [[alpha, "Alpha"], [beta, "Beta"]]) {
  await writeFile(join(dir, "README.md"), `# ${name}\n`);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "add", ".");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "-m", "init");
}

const OWNER = 1001;
const LONG = {
  kind: "needs_decision",
  title: "0.26.1 is out; run the remaining benchmark passes?",
  body: [
    "**Done:**",
    "",
    "- `v0.26.1` is on npm, tagged, with the GitHub release binaries.",
    "- 35 merged worktrees and their build folders are deleted; drive C: has **11.5 GB** free.",
    "- The main checkout's `node_modules` is untouched.",
    "",
    "**Still waiting on you:**",
    "",
    "- The task board: say \"open design\" when you want to look; its card goes to Telegram.",
    "- The test Redis: ask the Assistant to tell the manager chat to create it again.",
    "",
    "### What OK does",
    "",
    "Runs the 7 remaining benchmark passes (33/40 done, configuration E). Each pass needs about 0.5–1 GB of temporary space and stops by itself if the weekly limit goes past 90%.",
    "",
    "```sh",
    "bun run bench --config E --from 34 --to 40",
    "```",
    "",
    "The results land in `plans/reports/bench-261115/` with one chart per pass, and the summary table is updated after each one, so stopping halfway still leaves a usable report.",
    "",
    "If you would rather wait, Reply with a time and the manager will start them then.",
  ].join("\n"),
};
const CHOICES = {
  kind: "needs_decision",
  title: "0.26.2 (chat footer fix): when do we release it?",
  body: "Unit tests and the chat footer e2e pass in Docker. One small font warning on Safari remains; it does not block a release.",
  options: [
    { id: "tonight", label: "Release tonight", description: "Commit, push to main, then npm publish." },
    { id: "morning", label: "Wait until 08:00 tomorrow", description: "So you can check the build on your phone first." },
    { id: "fold", label: "Fold it into 0.27.0", description: "No separate patch release." },
  ],
};
const PICS = {
  kind: "needs_decision",
  title: "Phone chat footer: which of the two layouts?",
  body: "The manager took both layouts as screenshots. **1** keeps the usage ring on the left; **2** moves it into the ··· menu. OK takes layout 1.",
};
const URGENT = { kind: "urgent", title: "Staging is down after the deploy", body: "The health check fails since 14:02." };
const SETTLED_CHOICE = {
  kind: "needs_decision",
  title: "Clean up the 35 merged worktrees?",
  body: "They take 9 GB. Their branches are merged into main.",
  options: [
    { id: "all", label: "Delete all 35", description: "Worktrees and their build folders." },
    { id: "keep", label: "Keep them", description: "Nothing is deleted." },
  ],
};
const SETTLED_DISMISS = { kind: "needs_decision", title: "Rename the Assistant's Telegram bot?", body: "The name still says PPMBot." };
const checks = [];
const ok = (name) => { checks.push(name); console.log(`PASS ${name}`); };
let fake, backend, browser, web;

async function freePort() {
  const l = createServer();
  await new Promise((r) => l.listen(0, "127.0.0.1", r));
  const p = l.address().port;
  await new Promise((r) => l.close(r));
  return p;
}

/** A plain PNG of one colour with a darker band, so two screenshots look different. */
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const band = y > h * 0.75;
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) { row[1 + x * 3] = band ? r / 2 : r; row[2 + x * 3] = band ? g / 2 : g; row[3 + x * 3] = band ? b / 2 : b; }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

/** Two design screenshots of alpha, kept where `design_screenshot` keeps them. */
async function seedShots() {
  const dir = join(ppm, "design-shots");
  await mkdir(dir, { recursive: true });
  const ids = [];
  for (const [i, colour, label] of [[1, [99, 102, 241], "usage ring left"], [2, [16, 185, 129], "usage in menu"]]) {
    const id = `${String(i).repeat(8)}${"a".repeat(24)}`;
    await writeFile(join(dir, `${id}.png`), png(640, 400, colour));
    await writeFile(join(dir, `${id}.json`), JSON.stringify({
      id, projectPath: alpha, slug: "chat-footer", designTitle: "Chat footer", file: `layout-${i}.html`, label,
      width: 640, height: 400, createdAt: new Date().toISOString(),
    }));
    ids.push(id);
  }
  return ids;
}

const onboardingDone = () => {
  if (window.top !== window) return;
  localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
};

let failure = null;
try {
  const f = startChild("bun", ["tests/e2e/fixtures/fake-telegram-server.ts"], { env: { ...process.env }, log: join(logs, "fake-telegram.log"), ready: /FAKE_TELEGRAM (\{.*\})/ });
  fake = f.child;
  const fakeInfo = JSON.parse((await f.ready)[1]);
  const port = await freePort();
  web = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_HTML_TEST_REAL_HOME: homedir(),
    PPM_HTML_TEST_PORT: String(port), PPM_ASSISTANT_WEB_DIR: webDir,
    PPM_ASSISTANT_FIXTURE_STATE: join(sandbox, "scripted-provider-state.json"),
    PPM_ASSISTANT_APPROVAL_TIMEOUT_MS: "180000",
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
  for (const [name, path] of [["alpha", alpha], ["beta", beta]]) await fx.post("/api/projects", { name, path });
  await until("bridge running", async () => (await fx.tg("bridge")).running, 30000);
  const main = (await fx.post("/api/project/__assistant__/chat/sessions", { providerId: "claude", title: "Assistant" })).data.id;
  await fx.post("/api/assistant/telegram/bind", { sessionId: main, chatId: String(OWNER) });
  const { data: { settings } } = await fx.api("/api/assistant/settings");
  await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...settings, timezone: "UTC", digest: { enabled: false, time: "08:00" } }) });
  const aTitle = "Alpha lead";
  const aChat = (await fx.post("/api/project/alpha/chat/sessions", { providerId: "claude", title: aTitle })).data.id;
  const shotIds = await seedShots();

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true, args: ["--disable-dev-shm-usage"],
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
    ...(process.env.PPM_PLAYWRIGHT_CHANNEL ? { channel: process.env.PPM_PLAYWRIGHT_CHANNEL } : {}),
  });
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await desk.addInitScript(onboardingDone);
  const page = await desk.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));

  const k = loopKit({ web, fx, tg: phone(fakeInfo.control), page, shotsDir, owner: OWNER, record: (id, name) => ok(`setup ${id}: ${name}`) });
  await k.managerTurn("alpha", aChat, "seed-alpha", [], "Keep the alpha release plan", "default");
  await k.idle(aChat);
  const s = { alpha, beta, main, aChat, aTitle };
  // Alpha's manager from the chat menu, beta's created by the Assistant: two manager chips.
  await step1(k, s);

  /** One report filed by a project's manager chat, the way a manager turn files it. */
  const report = async (project, chat, label, args) => {
    await k.managerTurn(project, chat, label, [{ session: "report_to_assistant", args }], `Report: ${args.title}`);
    const [rec] = await k.answered(label, 1);
    assert.equal(rec.isError, false, rec.text);
    await k.idle(chat);
    return k.cardOf(args.kind, args.title);
  };
  // Two settled first (the oldest), then the four that wait; the Assistant keeps talking between
  // them so the waiting ones drift up among later messages.
  const choiceDone = await report("beta", s.bChat, "w-settled-choice", SETTLED_CHOICE);
  const dismissed = await report("alpha", s.aChat, "w-settled-dismiss", SETTLED_DISMISS);
  await fx.post(`/api/assistant/cards/${choiceDone.id}/choose`, { optionId: "all" });
  await fx.post(`/api/assistant/cards/${dismissed.id}/dismiss`, {});
  await k.idle(s.bChat);
  const long = await report("alpha", s.aChat, "w-long", LONG);
  await k.askAssistant("w-chatter-1", [], "What changed in 0.26.1?", { reply: "The release notes are short: the chat footer and the waiting cards. ".repeat(4) });
  await k.idle(main);
  const pics = await report("alpha", s.aChat, "w-pics", { ...PICS, images: shotIds });
  assert.equal(pics.payload.images?.length, 2, "the report kept both screenshots");
  const choices = await report("beta", s.bChat, "w-choices", CHOICES);
  const urgent = await report("beta", s.bChat, "w-urgent", URGENT);
  for (let i = 2; i <= 3; i++) {
    await k.askAssistant(`w-chatter-${i}`, [], `Unrelated question number ${i}`, { reply: `Answer ${i}: nothing to do with the cards. `.repeat(5) });
    await k.idle(main);
  }
  assert.equal((await k.waiting()).total, 4);
  const open = (await fx.api("/api/assistant/cards/open")).data;
  assert.deepEqual(open.cards.map((c) => c.id).sort(), [long.id, pics.id, choices.id, urgent.id].sort());
  ok("cards/open lists exactly the 4 waiting cards; the 2 settled ones are not counted");

  /** One screen's Assistant: `page` and its visible Assistant body; `tap` on a touch screen. */
  const view = (pg, tap = false) => {
    const body = () => pg.locator("[data-assistant-body]:visible").first();
    return {
      page: pg, tap, body,
      dock: () => body().locator("[data-waiting-dock]"),
      set: () => body().locator("[data-decision-set]"),
      stub: (card) => body().locator(`[data-decision-stub="${card.id}"]`),
      shown: (card) => body().locator(`[data-decision-set] [data-decision-card="${card.id}"]`),
      fold: (card) => body().locator(`[data-answered-card="${card.id}"]`),
      press: (loc) => (tap ? loc.tap() : loc.click()),
    };
  };

  /**
   * Asserts what the stream promises: the decisions are answered in one set, drawn whole as the
   * stream's last item; each keeps a one-line stub at its own place; no card is drawn twice.
   */
  async function checkStream(v, label) {
    const { body, set, stub, fold } = v;
    assert.equal(await set().count(), 1, `${label}: one set of decisions`);
    for (const c of [long, pics, choices, urgent]) {
      assert.equal(await stub(c).count(), 1, `${label}: "${c.title}" keeps a stub at its place`);
      assert.match(await stub(c).innerText(), /waiting in the set below/, `${label}: the stub says where the card is`);
      assert.equal(await body().locator(`[data-waiting-card="${c.id}"]`).count(), 0, `${label}: "${c.title}" is not drawn whole in the stream`);
    }
    assert.equal(await set().locator("[data-question-tab]").count(), 4, `${label}: one tab per decision`);
    // Urgent first, as everywhere: the first tab is the urgent card's.
    assert.equal(await set().locator("[data-question-tab]").first().getAttribute("title"), `beta · ${URGENT.title}`, `${label}: urgent first`);
    assert.equal(await body().locator("[data-waiting-cards]").count(), 0, `${label}: no bar above the stream`);
    // The set is the stream's last item, and nothing in it scrolls on its own.
    const last = await set().evaluate((el) => {
      const list = el.closest("[data-chat-list]");
      const items = [...list.querySelectorAll("[data-timeline-item], [data-msg-index]")].filter((n) => n.getBoundingClientRect().height > 0);
      const mine = items.findIndex((n) => n.contains(el));
      const inner = [...el.querySelectorAll("*")].filter((n) => /(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1);
      return { mine, count: items.length, scrollers: inner.length, overflowX: el.scrollWidth - el.clientWidth };
    });
    assert.equal(last.mine, last.count - 1, `${label}: the set is the stream's last item (${JSON.stringify(last)})`);
    assert.equal(last.scrollers, 0, `${label}: the set has no scroll box of its own`);
    assert.ok(last.overflowX <= 1, `${label}: nothing in the set is wider than it (${last.overflowX}px)`);
    for (const c of [choiceDone, dismissed]) {
      assert.equal(await fold(c).count(), 1, `${label}: "${c.title}" is folded to one line`);
      assert.equal(await fold(c).locator("[data-assistant-card]").count(), 0, `${label}: folded, its card is not drawn`);
    }
  }

  /** Where `loc` sits against the readable part of the stream (list top, dock top), in px. */
  const readable = (v, loc) => loc.evaluate((el) => {
    let list = el.parentElement;
    while (list && !/(auto|scroll)/.test(getComputedStyle(list).overflowY)) list = list.parentElement;
    const body = el.closest("[data-assistant-body]");
    const dock = body.querySelector("[data-waiting-dock]");
    const r = el.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
      listTop: Math.round(l.top), listBottom: Math.round(l.bottom),
      floor: Math.round(dock ? Math.min(dock.getBoundingClientRect().top, l.bottom) : l.bottom),
    };
  });

  /** Steps the chip to `card` and presses it: the stream lands on the set, on that card's tab. */
  async function jumpTo(v, card) {
    const { body, set, shown, press, page: pg } = v;
    const go = body().locator("[data-waiting-go]");
    for (let i = 0; i < 5 && (await go.getAttribute("aria-label")) !== `Go to "${card.title}", waiting on you`; i++) {
      await press(body().locator('button[aria-label="Next waiting card"]'));
      await pg.waitForTimeout(50);
    }
    await press(go);
    await shown(card).waitFor({ timeout: 5000 });
    await body().locator("[data-decision-set][data-highlighted]").waitFor({ timeout: 5000 });
    await pg.waitForTimeout(700); // the smooth scroll, then the outline
    const at = await readable(v, set());
    const row = await readable(v, set().locator("[data-decision-actions]"));
    const fits = at.top >= at.listTop - 1 && at.bottom <= at.floor + 1;
    const rowShows = row.top >= at.listTop - 1 && row.bottom <= at.floor + 1;
    assert.ok(fits || rowShows, `the jump shows the set whole, or its buttons, above the dock (${JSON.stringify({ at, row })})`);
    // Its buttons are clear of the message navigator floating in the list's corner.
    const clear = await set().locator("[data-decision-actions]").evaluate((el) => {
      const nav = el.closest("[data-chat-list]")?.querySelector("[data-chat-scroll-nav]")?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return !nav || nav.height === 0 || r.bottom <= nav.top + 1 || r.top >= nav.bottom - 1 || r.right <= nav.left + 1;
    });
    assert.ok(clear, `the set's buttons are not under the message navigator (${card.title})`);
    return fits;
  }

  /** The answered card's line, folded and then opened (read-only, no buttons). */
  async function answeredBothWays(v, size, shoot) {
    const { fold, press, page: pg } = v;
    const line = fold(choiceDone).locator("[data-answered-toggle]");
    await line.scrollIntoViewIfNeeded();
    assert.match(await line.innerText(), /Clean up the 35 merged worktrees\?/);
    assert.match(await line.innerText(), /Chose "Delete all 35" in PPM/);
    await pg.waitForTimeout(200);
    await shoot("answered-folded");
    await press(line);
    const full = fold(choiceDone).locator("[data-assistant-card]");
    await full.waitFor({ timeout: 5000 });
    assert.equal(await full.locator("[data-card-actions]").count(), 0, `${size}: opened, it is read-only`);
    await press(line);
    await until(`${size}: folded again`, async () => (await full.count()) === 0, 5000);
    ok(`${size}: an answered decision is still one folded line that opens read-only and folds again`);
  }

  /** What every size checks and shoots, without sending anything. */
  async function shootSize(v, size, shot) {
    const { body, dock, set, shown, press, page: pg } = v;
    await dock().waitFor({ timeout: 30000 });
    await set().waitFor({ timeout: 30000 });
    assert.equal(await dock().getAttribute("data-waiting-count"), "4");
    await checkStream(v, size);
    assert.equal(await dock().innerText().then((t) => t.replace(/\s+/g, "")), "Waiting41/4", `${size}: the chip says Waiting, the count and n/N only`);
    // Buttons at the standard: text 28px (26 on a phone), icon 24px (22).
    const heights = await set().evaluate((el) => {
      const h = (sel) => [...el.querySelectorAll(sel)].map((b) => Math.round(b.getBoundingClientRect().height)).filter((x) => x > 0);
      return { send: h("[data-decision-send-one], [data-decision-send-all]"), icon: h("[data-decision-fold], [data-decision-attach]") };
    });
    const [textH, iconH] = size === "390" ? [26, 22] : [28, 24];
    assert.ok(heights.send.every((x) => x === textH), `${size}: text buttons are ${textH}px (${heights.send})`);
    assert.ok(heights.icon.every((x) => x === iconH), `${size}: icon buttons are ${iconH}px (${heights.icon})`);
    await pg.waitForTimeout(600);
    await shot("set");
    ok(`${size}: decisions answered in one set at the stream's end (urgent first), a stub at each card's place, standard button sizes, nothing wider than the set`);

    await jumpTo(v, long);
    await shot("long-card");
    await jumpTo(v, choices);
    assert.equal(await shown(choices).locator("[data-question-option]").count(), 3, `${size}: three choices as tiles`);
    await shot("choices-card");
    await jumpTo(v, pics);
    await shown(pics).locator("[data-card-images] img").first().waitFor({ timeout: 15000 });
    assert.equal(await shown(pics).locator("[data-card-images] img").count(), 2, `${size}: both screenshots are shown`);
    await shot("images-card");
    // A press on a stub lands on the same tab.
    await v.stub(long).scrollIntoViewIfNeeded();
    await press(v.stub(long));
    await shown(long).waitFor({ timeout: 5000 });
    ok(`${size}: the chip and a stub land the stream on the set, on that card's tab: long, choices, images`);

    await set().locator("[data-decision-fold]").scrollIntoViewIfNeeded();
    await press(set().locator("[data-decision-fold]"));
    await body().locator("[data-decision-set='folded']").waitFor({ timeout: 5000 });
    assert.match(await body().locator("[data-decision-set='folded']").innerText(), /4 decisions waiting/);
    await shot("set-folded");
    await press(body().locator("[data-decision-unfold]"));
    await body().locator("[data-decision-set='open']").waitFor({ timeout: 5000 });
    ok(`${size}: the set folds to one bar and opens again`);

    await answeredBothWays(v, size, shot);
  }

  // ---- Desktop 1440: the Assistant's window maximized ----
  await page.goto(`${web}/project/alpha/assistant`);
  const win = page.locator('[aria-roledescription="window"]', { has: page.locator("[data-assistant-body]") }).first();
  await win.waitFor({ timeout: 30000 });
  await win.locator('[role="toolbar"][aria-label$="title bar"]').dblclick({ position: { x: 120, y: 12 } });
  await page.waitForTimeout(400);
  const wide = await win.boundingBox();
  assert.ok(wide.width >= 1100, `the window fills the desktop (${wide.width}px)`);
  const desk1440 = view(page);
  const { body, dock, set, shown } = desk1440;
  await shootSize(desk1440, "1440", (name) => page.screenshot({ path: join(shotsDir, `b-1440-${name}.png`) }));

  // A red count lands on its project's first waiting card, on its tab.
  await body().locator('[data-manager-chip="alpha"] [data-manager-chip-count]').click();
  await body().locator("[data-decision-set][data-highlighted]").waitFor({ timeout: 5000 });
  ok("1440: alpha's red count jumps the stream to the set, on alpha's first waiting card");

  // ---- A floating window 800 px wide ----
  await win.locator('[role="toolbar"][aria-label$="title bar"]').dblclick({ position: { x: 120, y: 12 } });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("ppm-windows") ?? "[]");
    for (const w of saved) if (w.kind === "tab-host") { w.state = "normal"; delete w.restoreTo; w.rect = { ...w.rect, w: 800, h: 840, y: 8, x: Math.max(0, w.rect.x + w.rect.w - 800) }; }
    localStorage.setItem("ppm-windows", JSON.stringify(saved));
  });
  await page.reload();
  await win.waitFor({ timeout: 30000 });
  await body().locator("[data-waiting-dock]").waitFor({ timeout: 30000 });
  const floating = await win.boundingBox();
  assert.ok(Math.abs(floating.width - 800) <= 16, `the floating window is about 800px wide (${floating.width})`);
  await shootSize(view(page), "800", (name) => win.screenshot({ path: join(shotsDir, `b-800-${name}.png`) }));

  // ---- Phone 390, then 320 for overflow ----
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await phoneCtx.addInitScript(onboardingDone);
  const mob = await phoneCtx.newPage();
  mob.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
  await mob.goto(`${web}/project/alpha/assistant`);
  await shootSize(view(mob, true), "390", (name) => mob.screenshot({ path: join(shotsDir, `b-390-${name}.png`) }));
  await mob.setViewportSize({ width: 320, height: 640 });
  await mob.waitForTimeout(500);
  const narrow = view(mob, true);
  await jumpTo(narrow, pics);
  const spill = await narrow.set().evaluate((el) => {
    const w = document.documentElement.clientWidth;
    return [...el.querySelectorAll("*")].filter((n) => !n.closest("[role=tablist]") && n.getBoundingClientRect().right > w + 0.5).map((n) => n.outerHTML.slice(0, 80));
  });
  assert.deepEqual(spill, [], "320: nothing in the set reaches past the screen");
  await mob.screenshot({ path: join(shotsDir, "b-320-images-card.png") });
  ok("320: the set fits a 320px screen");

  // ---- A manager chat shows its decisions as the set, in its bar ----
  await body().locator('[data-manager-chip="alpha"] button').first().click();
  const mgr = page.locator("[data-manager-waiting-cards]:visible").first();
  await mgr.waitFor({ timeout: 30000 });
  await mgr.locator("[data-decision-set]").waitFor({ timeout: 15000 });
  assert.equal(await mgr.locator("[data-question-tab]").count(), 2, "the alpha manager's set holds its two decisions only");
  await page.screenshot({ path: join(shotsDir, "b-1440-manager-chat-bar.png") });
  ok("the manager chat shows its own decisions as a set of two in its bar");

  // ---- Sending: one on its own, then the rest through the review ----
  await page.goto(`${web}/project/alpha/assistant`);
  await set().waitFor({ timeout: 30000 });
  await jumpTo(desk1440, choices);
  await shown(choices).locator("[data-question-option]").nth(1).click();
  await set().locator("[data-decision-send-one]").click();
  await until("choices answered", async () => (await fx.api("/api/assistant/cards/open")).data.cards.every((c) => c.id !== choices.id), 15000);
  await page.waitForTimeout(400);
  assert.equal(await set().locator(`[data-question-tab="${choices.id}"]`).count(), 0, "the sent card's tab leaves the set");
  assert.match(await set().locator("[data-decision-flash='sent']").innerText(), /Sent/, "a line says the card was sent");
  assert.match(await set().locator("[data-decision-send-all]").innerText(), /\(0\/3\)/, "the rest still wait, none picked");
  await page.screenshot({ path: join(shotsDir, "b-1440-sent-one-rest-waiting.png") });
  const choicesNow = (await fx.api("/api/assistant/cards?limit=50")).data.cards.find((c) => c.id === choices.id);
  assert.equal(choicesNow.answer?.choice?.id, "morning", "the server took the choice pressed");
  ok("1440: Send this one answers that card alone (choice morning); its tab leaves; the other three still wait");

  // OK on the long card; words and a picture on the screenshots card; the urgent one left unanswered.
  await jumpTo(desk1440, long);
  await shown(long).locator("[data-question-option]").first().click();
  await jumpTo(desk1440, pics);
  await shown(pics).locator("[data-decision-reply]").fill("Layout 1, but the ring a little smaller — see the picture.");
  await shown(pics).locator('input[type="file"]').setInputFiles({ name: "ring.png", mimeType: "image/png", buffer: png(320, 200, [244, 63, 94]) });
  await shown(pics).locator("[data-decision-reply-images] img").waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(shotsDir, "b-1440-reply-with-picture.png") });
  await set().locator("[data-decision-send-all]").click();
  const review = set().locator("[data-decision-review]");
  await review.waitFor({ timeout: 5000 });
  assert.equal(await review.locator("[data-review-row]").count(), 3, "the review lists the three waiting cards");
  assert.match(await review.innerText(), /OK — go ahead/);
  assert.match(await review.innerText(), /Reply: “Layout 1, but the ring a little smaller — see the picture\.” \+ 1 picture/);
  assert.match(await review.innerText(), /No answer yet — keeps waiting/);
  // The review is brought into view: its Send button is on screen, above the footer.
  await page.waitForTimeout(500);
  const sendAt = await readable(desk1440, review.locator("[data-decision-send-reviewed]"));
  assert.ok(sendAt.top >= sendAt.listTop - 1 && sendAt.bottom <= sendAt.floor + 1, `the review's Send is in view (${JSON.stringify(sendAt)})`);
  await page.screenshot({ path: join(shotsDir, "b-1440-send-all-review.png") });
  await review.locator("[data-decision-send-reviewed]").click();
  await until("long and pics answered", async () => {
    const ids = (await fx.api("/api/assistant/cards/open")).data.cards.map((c) => c.id);
    return !ids.includes(long.id) && !ids.includes(pics.id) && ids.includes(urgent.id);
  }, 20000);
  const uploads = readdirSync(join(ppm, "uploads")).filter((n) => /^card-.*\.png$/.test(n));
  assert.equal(uploads.length, 1, `the picture was stored once by the server (${uploads})`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shotsDir, "b-1440-after-send-all.png") });
  assert.equal((await k.waiting()).total, 1, "only the urgent card still waits");
  ok("1440: Send all goes through the review, sends the OK and the reply with its picture (stored by the server), and leaves the unanswered card waiting");

  // ---- Telegram: a photo sent as a reply to the urgent card answers it ----
  const tg = phone(fakeInfo.control);
  const onPhone = await tg.waitFor(OWNER, "the urgent card", (m) => m.text.includes(URGENT.title));
  await tg.photo(OWNER, "This is what I see on staging.", {
    // Telegram re-encodes every photo as JPEG, so the fake's own JPEG bytes stand for it: PNG bytes
    // under a .jpg name would be refused (rightly) as not the image they say they are.
    extra: { reply_to_message: { message_id: onPhone.message_id, chat: { id: OWNER, type: "private" }, date: 0 } },
    // A real (1x1) JPEG: the server reads its pixel size, which the fake's 4-byte stand-in has none of.
    bytes: Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64"),
  });
  try {
    await tg.waitText(OWNER, "Sent to the", 20000);
  } catch (e) {
    const last = (await tg.sent(OWNER)).slice(-4).map((m) => `#${m.message_id}: ${m.text.slice(0, 160)}`);
    throw new Error([e.message, "last messages:", ...last, `card message #${onPhone.message_id}`].join(" | "));
  }
  await until("urgent answered from Telegram", async () => (await k.waiting()).total === 0, 20000);
  const urgentNow = (await fx.api("/api/assistant/cards?limit=50")).data.cards.find((c) => c.id === urgent.id);
  assert.equal(urgentNow.answer?.channel, "telegram", "answered on Telegram");
  await writeFile(join(shotsDir, "telegram-chat.json"), JSON.stringify(await tg.sent(OWNER), null, 2));
  ok("Telegram: a photo with a caption, sent as a reply to the urgent card, answers it");

  // ---- Nothing waits ----
  await until("desktop dock gone", async () => (await dock().count()) === 0, 15000);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shotsDir, "b-1440-nothing-waiting.png") });
  assert.equal(await body().locator("[data-decision-set]").count(), 0, "no set left");
  assert.equal(await body().locator("[data-decision-stub]").count(), 0, "no stub left");
  assert.ok(await body().locator("[data-answered-card]").count() >= 6, "every settled card is folded");
  ok("no card left: the chip, the set and the stubs are gone; every settled card is one folded line");

  const unexpected = pageErrors.filter((e) => !/read the 'serviceWorker' property/.test(e));
  if (unexpected.length) throw new Error(`page errors:\n${unexpected.join("\n")}`);
} catch (error) {
  failure = String(error.stack ?? error);
  console.error(`FAIL ${failure}`);
  try {
    for (const [i, ctx] of (browser?.contexts() ?? []).entries()) await ctx.pages()[0]?.screenshot({ path: join(shotsDir, `failure-${i}.png`) });
  } catch { /* none */ }
} finally {
  await browser?.close().catch(() => {});
  if (backend && backend.exitCode === null) {
    const exited = new Promise((r) => backend.once("exit", r));
    await fetch(`${web}/__assistant-test/exit`, { method: "POST" }).catch(() => {});
    const timer = setTimeout(() => backend.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
  if (fake && fake.exitCode === null) fake.kill();
  console.log(`stopped fixture pid=${backend?.pid} (exit ${backend?.exitCode}), fake telegram pid=${fake?.pid}`);
  await writeFile(join(shotsDir, "results.json"), JSON.stringify({ checks, failure }, null, 2));
  console.log(`${checks.length} checks passed${failure ? ", then a failure" : ""}; screenshots in ${shotsDir}; logs in ${logs}`);
  if (failure) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
