// "Waiting on you" in the PPM Assistant, end to end at three sizes (1440 desktop, an 800 px
// floating window, a 390 px phone). Every waiting card is drawn once, whole, at its own place in
// the stream, with its buttons at its end; one "Waiting" chip in the chat footer's context row
// counts them and jumps the stream to each (outlined). A decision the user already answered folds to one line that opens it
// again, read-only. A manager chat still shows its own report in its bar, and the dock and every
// red count are gone once nothing waits.
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
      inStream: (card) => body().locator(`[data-waiting-card="${card.id}"]`),
      fold: (card) => body().locator(`[data-answered-card="${card.id}"]`),
      press: (loc) => (tap ? loc.tap() : loc.click()),
    };
  };

  /** Asserts what the stream promises: each waiting card once, whole, buttons at its end. */
  async function checkStream(v, label) {
    const { body, inStream, fold } = v;
    for (const c of [long, pics, choices, urgent]) {
      assert.equal(await inStream(c).count(), 1, `${label}: "${c.title}" is drawn once`);
      assert.equal(await inStream(c).locator("[data-card-actions]").count(), 1, `${label}: it has one row of buttons`);
      assert.equal(await inStream(c).locator("[data-card-actions][data-sticky]").count(), 0, `${label}: nothing sticks`);
      // The buttons are the card's last row: nothing of the card is drawn below them.
      const gap = await inStream(c).evaluate((el) => {
        const card = el.querySelector("article").getBoundingClientRect();
        const row = el.querySelector("[data-card-actions]").getBoundingClientRect();
        return Math.round(card.bottom - row.bottom);
      });
      assert.ok(gap <= 2, `${label}: the buttons end "${c.title}" (${gap}px below them)`);
    }
    assert.equal(await body().locator("[data-waiting-cards]").count(), 0, `${label}: no bar above the stream`);
    assert.equal(await body().locator("[data-card-pointer]").count(), 0, `${label}: no pointer rows`);
    // The long card's body is not clipped: its text box is as tall as its text.
    const clipped = await inStream(long).locator("[data-card-text]").evaluate((el) => el.scrollHeight - el.clientHeight);
    assert.ok(clipped <= 1, `${label}: the long card's text is not clipped (${clipped}px hidden)`);
    for (const c of [choiceDone, dismissed]) {
      assert.equal(await fold(c).count(), 1, `${label}: "${c.title}" is folded to one line`);
      assert.equal(await fold(c).locator("[data-assistant-card]").count(), 0, `${label}: folded, its card is not drawn`);
    }
  }

  /**
   * Where `loc` sits against the readable part of the stream: the list's top and the dock's top
   * (nothing under the dock can be read). All in px relative to the viewport.
   */
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

  /**
   * Steps the chip to `card` and presses it: the stream lands on it. The chip names no card, so the
   * card it is on is read from its accessible name.
   */
  async function jumpTo(v, card) {
    const { body, inStream, press, page: pg } = v;
    const go = body().locator("[data-waiting-go]");
    for (let i = 0; i < 5 && (await go.getAttribute("aria-label")) !== `Go to "${card.title}", waiting on you`; i++) {
      await press(body().locator('button[aria-label="Next waiting card"]'));
      await pg.waitForTimeout(50);
    }
    await press(go);
    await body().locator(`[data-waiting-card="${card.id}"][data-highlighted]`).waitFor({ timeout: 5000 });
    await pg.waitForTimeout(700); // the smooth scroll, then the outline fading in (300 ms)
    // The whole card above the dock; a card taller than the stream shows its buttons above it.
    const at = await readable(v, inStream(card));
    const row = await readable(v, inStream(card).locator("[data-card-actions]"));
    // Either all of the card shows, or (a card taller than the room left) its buttons do.
    const fits = at.top >= at.listTop - 1 && at.bottom <= at.floor + 1;
    const rowShows = row.top >= at.listTop - 1 && row.bottom <= at.floor + 1;
    assert.ok(fits || (rowShows && at.height > at.floor - at.listTop - 90), `the jump shows "${card.title}" whole, or a tall card's buttons, above the dock (${JSON.stringify({ at, row })})`);
    // Its buttons are clear of the message navigator floating in the list's corner.
    const clear = await inStream(card).locator("[data-card-actions]").evaluate((el) => {
      const nav = el.closest("[data-chat-list]")?.querySelector("[data-chat-scroll-nav]")?.getBoundingClientRect();
      const row = el.getBoundingClientRect();
      return !nav || nav.height === 0 || row.bottom <= nav.top + 1 || row.top >= nav.bottom - 1;
    });
    if (row.bottom <= at.floor + 1 && row.top >= at.listTop - 1) assert.ok(clear, `the buttons of "${card.title}" are not under the message navigator`);
    return fits;
  }

  /** The answered card's line, folded and then opened (read-only, no buttons). */
  async function answeredBothWays(v, size, shoot) {
    const { fold, press, page: pg } = v;
    const line = fold(choiceDone).locator("[data-answered-toggle]");
    await line.scrollIntoViewIfNeeded();
    const h = (await line.boundingBox()).height;
    assert.ok(h >= 44, `${size}: the folded line is at least 44px tall (${h})`);
    assert.match(await line.innerText(), /Clean up the 35 merged worktrees\?/);
    assert.match(await line.innerText(), /beta/);
    assert.match(await line.innerText(), /Chose "Delete all 35" in PPM/);
    await pg.waitForTimeout(200);
    await shoot("answered-folded");
    await press(line);
    const full = fold(choiceDone).locator("[data-assistant-card]");
    await full.waitFor({ timeout: 5000 });
    assert.equal(await full.locator("[data-card-actions]").count(), 0, `${size}: opened, it is read-only`);
    assert.match(await full.locator("[data-card-status-line]").innerText(), /Chose "Delete all 35" in PPM/);
    // Opening it brought its last line (how it ended) above the dock, by itself.
    await pg.waitForTimeout(300);
    const end = await readable(v, full.locator("[data-card-status-line]"));
    assert.ok(end.top >= end.listTop - 1 && end.bottom <= end.floor + 1, `${size}: the opened card's last line shows above the dock (${JSON.stringify(end)})`);
    await shoot("answered-opened");
    await press(line);
    await until(`${size}: folded again`, async () => (await full.count()) === 0, 5000);
    ok(`${size}: an answered card is one ≥44px line naming title, project, answer and time; it opens read-only with its last line above the footer, and folds again`);
  }

  /** The four shots every size takes, plus the answered card both ways. */
  async function shootSize(v, size, shot) {
    const { body, dock, inStream, page: pg } = v;
    await dock().waitFor({ timeout: 30000 });
    assert.equal(await dock().getAttribute("data-waiting-count"), "4");
    await checkStream(v, size);
    // One chip on the left of the footer's context row, the size of the footer's other chips; no
    // card title and no project on it.
    assert.equal(await body().locator("[data-chat-context-row] [data-waiting-dock]").count(), 1, `${size}: the chip is in the footer's context row`);
    assert.equal(await dock().innerText().then((t) => t.replace(/\s+/g, "")), "Waiting41/4", `${size}: the chip says Waiting, the count and n/N only`);
    const chipH = (await dock().boundingBox()).height;
    assert.ok(chipH <= 34, `${size}: the chip is footer-chip sized (${chipH}px)`);
    // Each part answers a press at least 44px across on a phone, and the row's clip cuts none of it.
    const hits = await dock().evaluate((chip) => {
      let zone = chip.parentElement;
      while (zone && getComputedStyle(zone).overflow !== "hidden" && getComputedStyle(zone).overflowX !== "hidden") zone = zone.parentElement;
      const z = zone.getBoundingClientRect();
      return [...chip.querySelectorAll("button")].map((b) => {
        const r = b.getBoundingClientRect();
        const a = getComputedStyle(b, "::after");
        const px = (v) => (v === "auto" ? 0 : parseFloat(v) || 0);
        const hit = a.content === "none" || a.content === "normal"
          ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
          : { left: r.left - (-px(a.left)), right: r.right + -px(a.right), top: r.top + px(a.top), bottom: r.bottom - px(a.bottom) };
        return {
          label: b.getAttribute("aria-label"), w: Math.round(hit.right - hit.left), h: Math.round(hit.bottom - hit.top),
          clipped: hit.right > z.right + 0.5 || hit.left < z.left - 0.5 || hit.top < z.top - 0.5 || hit.bottom > z.bottom + 0.5,
        };
      });
    });
    if (size === "390") {
      for (const h of hits) {
        assert.ok(h.h >= 44, `390: "${h.label}" answers a press 44px tall (${h.h})`);
        if (h.label !== null && !h.label.startsWith("Go to")) assert.ok(h.w >= 44, `390: "${h.label}" answers a press 44px wide (${h.w})`);
        assert.ok(!h.clipped, `390: "${h.label}" is not cut by the row's clip`);
      }
    }
    await pg.waitForTimeout(800); // the messages under the dock finish painting
    // At the stream's end, the last message scrolls fully above the dock: the dock starts where the
    // list ends, never over it.
    const lastRow = body().locator("[data-chat-list] [data-timeline-item], [data-chat-list] [data-msg-index]").last();
    const last = await readable(v, lastRow);
    assert.ok(last.floor >= last.listBottom - 1, `${size}: the dock does not cover the stream (${JSON.stringify(last)})`);
    assert.ok(last.bottom <= last.floor + 1, `${size}: the last message is fully above the dock (${JSON.stringify(last)})`);
    await shot("dock");
    ok(`${size}: no bar above the stream; each waiting card drawn once and whole with its buttons at its end; one simple chip in the footer's context row, 44px presses on a phone`);

    const longFits = await jumpTo(v, long);
    await shot("long-card");
    if (!longFits) {
      // Taller than the stream: landed on its buttons. Its start, scrolled to by hand.
      await inStream(long).evaluate((el) => {
        let list = el.parentElement;
        while (list && !/(auto|scroll)/.test(getComputedStyle(list).overflowY)) list = list.parentElement;
        list.scrollTop += el.getBoundingClientRect().top - list.getBoundingClientRect().top - 12;
      });
      await pg.waitForTimeout(200);
      await shot("long-card-top");
    }
    await jumpTo(v, choices);
    assert.equal(await inStream(choices).locator("[data-card-choice]").count(), 3, `${size}: three choices on the card`);
    await shot("choices-card");
    await jumpTo(v, pics);
    await inStream(pics).locator("[data-card-images] img").first().waitFor({ timeout: 15000 });
    assert.equal(await inStream(pics).locator("[data-card-images] img").count(), 2, `${size}: both screenshots are shown`);
    await shot("images-card");
    ok(`${size}: the chip's arrows and press land the stream on each card, outlined, the card (or a tall card's buttons) above the footer: long, choices, images`);

    await answeredBothWays(v, size, shot);
  }

  // ---- Desktop 1440: the Assistant's window maximized ----
  await page.goto(`${web}/project/alpha/assistant`);
  const win = page.locator('[aria-roledescription="window"]', { has: page.locator("[data-assistant-body]") }).first();
  await win.waitFor({ timeout: 30000 });
  await win.locator('[role="toolbar"][aria-label$="title bar"]').dblclick({ position: { x: 120, y: 12 } });
  await page.waitForTimeout(400);
  const wide = await win.boundingBox();
  // The window layer is the desktop beside the rail and the sidebar.
  assert.ok(wide.width >= 1100, `the window fills the desktop (${wide.width}px)`);
  const desk1440 = view(page);
  const { body, dock, inStream } = desk1440;
  await shootSize(desk1440, "1440", (name) => page.screenshot({ path: join(shotsDir, `b-1440-${name}.png`) }));

  // A red count lands on its project's first waiting card, outlined.
  await body().locator('[data-manager-chip="alpha"] [data-manager-chip-count]').click();
  await body().locator(`[data-waiting-card="${long.id}"][data-highlighted]`).waitFor({ timeout: 5000 });
  ok("1440: alpha's red count jumps the stream to alpha's first waiting card, outlined");

  // Reply quotes the card over the composer, as before.
  await inStream(long).getByRole("button", { name: "Reply" }).click();
  const quote = body().locator("[data-card-reply-quote]");
  await quote.waitFor({ timeout: 5000 });
  assert.match(await quote.innerText(), /Replying to card/);
  await body().locator('button[aria-label="Stop replying to this card"]').click();
  await k.composer().waitFor({ timeout: 5000 });
  ok("1440: Reply on a card in the stream quotes it over the composer");

  // ---- A floating window 800 px wide ----
  // Set as the user would leave it (the window's saved rect, what a drag of its edge writes),
  // then reloaded: 800 wide, nearly the screen's height.
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

  // ---- Phone 390 ----
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await phoneCtx.addInitScript(onboardingDone);
  const mob = await phoneCtx.newPage();
  mob.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
  await mob.goto(`${web}/project/alpha/assistant`);
  await shootSize(view(mob, true), "390", (name) => mob.screenshot({ path: join(shotsDir, `b-390-${name}.png`) }));

  // ---- A manager chat still shows its own report in its bar ----
  await body().locator('[data-manager-chip="alpha"] button').first().click();
  const mgr = page.locator("[data-manager-waiting-cards]:visible").first();
  await mgr.waitFor({ timeout: 30000 });
  assert.match(await mgr.innerText(), /0\.26\.1 is out|Phone chat footer/);
  await page.screenshot({ path: join(shotsDir, "b-1440-manager-chat-bar.png") });
  ok("the manager chat still shows its own open report above its composer");

  // ---- Nothing waits ----
  for (const c of open.cards) await fx.post(`/api/assistant/cards/${c.id}/dismiss`, {});
  assert.equal((await k.waiting()).total, 0);
  await page.goto(`${web}/project/alpha/assistant`);
  await body().locator('[data-manager-chip="alpha"]').waitFor({ timeout: 30000 });
  await until("desktop dock gone", async () => (await dock().count()) === 0, 15000);
  assert.equal(await body().locator("[data-manager-chip-count]").count(), 0, "no red count left on a chip");
  assert.equal(await body().locator("[data-waiting-card]").count(), 0, "no waiting card left in the stream");
  assert.ok(await body().locator("[data-answered-card]").count() >= 6, "every settled card is folded");
  await page.screenshot({ path: join(shotsDir, "b-1440-nothing-waiting.png") });
  ok("no card left: the chip and every red count are gone; every settled card is one folded line");

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
