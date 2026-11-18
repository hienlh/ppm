// The set of decisions holds only cards that still wait, on every surface at once: the PPM
// Assistant's window (1440, maximized), a manager chat's "Waiting on you" bar (1440) and the
// Assistant on a phone (390). Seven decisions from alpha's manager chat, then, with all three
// open and never reloaded:
//   1. one answered in PPM (the Assistant window's Send this one),
//   2. one answered on Telegram while the phone has that very card open,
//   3. one dismissed from the manager chat's bar,
//   4. one closed by the server on its own while the Assistant window has it open,
//   5. the last three answered one by one, after which the set and every count are gone.
// After each step the set's tabs, its heading, its "N/M" and the Waiting count agree on every
// surface, a surface whose open card left shows the next one that waits, and nothing kept a tab
// for a card that no longer waits.
//
// Same disposable fixture as the manager loop (tests/e2e/fixtures/assistant-server.ts with
// PPM_ASSISTANT_MANAGER_LOOP=1 and a fake Telegram): no real model, no real PPM data.
//
//   PPM_ASSISTANT_WEB_DIR=<web dist with Monaco staged> PPM_DS_SHOTS=<dir> PPM_DS_LABEL=after \
//     node tests/e2e/assistant-decision-set-drop-answered-e2e.mjs
//
// PPM_DS_OBSERVE=1 records what each surface shows instead of asserting it (for screenshots of a
// build without the fix); the run then never fails on a count.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { fixtureApi, phone, startChild, until } from "./assistant-telegram/harness.mjs";
import { loopKit } from "./assistant-manager-loop/loop-kit.mjs";
import { step1 } from "./assistant-manager-loop/steps-managers.mjs";

const OBSERVE = process.env.PPM_DS_OBSERVE === "1";
const LABEL = process.env.PPM_DS_LABEL ?? (OBSERVE ? "before" : "after");
const sandbox = await mkdtemp(join(tmpdir(), "ppm-decision-set-e2e-"));
const shotsDir = resolve(process.env.PPM_DS_SHOTS ?? join(sandbox, "shots"));
const logs = join(sandbox, "logs");
const ppm = join(sandbox, "ppm"), home = join(sandbox, "home");
const alpha = join(sandbox, "alpha"), beta = join(sandbox, "beta");
await Promise.all([shotsDir, logs, ppm, home, alpha, beta].map((p) => mkdir(p, { recursive: true })));
for (const name of readdirSync(shotsDir)) if (name.startsWith(`${LABEL}-`) && name.endsWith(".png")) rmSync(join(shotsDir, name), { force: true });
const webDir = resolve(process.env.PPM_ASSISTANT_WEB_DIR ?? "dist/web");
assert(existsSync(join(webDir, "assets/monaco/vs/loader.js")), `no web dist with Monaco at ${webDir}`);

for (const [dir, name] of [[alpha, "Alpha"], [beta, "Beta"]]) {
  await writeFile(join(dir, "README.md"), `# ${name}\n`);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "add", ".");
  git("-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", "commit", "-q", "-m", "init");
}

const OWNER = 1001;
const TITLES = [
  "Release 0.26.14 tonight?",
  "Delete the 12 merged worktrees?",
  "Rename the staging bucket?",
  "Run the remaining benchmark passes?",
  "Turn on the nightly e2e in Docker?",
  "Move the docs site to the new domain?",
  "Archive the old Telegram bot?",
];
const checks = [];
const observed = [];
const ok = (name) => { checks.push(name); console.log(`PASS ${name}`); };
let fake, backend, browser;

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

/** What one surface's set says about itself, read from the page as drawn. */
const readSurface = (root) => root.evaluate((el) => {
  const set = el.querySelector("[data-decision-set]");
  const chipEl = el.querySelector("[data-waiting-dock]") ?? el.querySelector("[data-waiting-cards]");
  // The Assistant's Waiting chip, or the manager chat bar's own count.
  const chip = chipEl ? Number(chipEl.getAttribute("data-waiting-count")) : 0;
  if (!set) return { set: false, chip, heading: 0, position: null, tabs: 0, ids: [], shown: null, flash: null };
  const head = set.firstElementChild?.textContent ?? "";
  const heading = Number(/(\d+) decisions? waiting/.exec(set.textContent ?? "")?.[1] ?? NaN);
  const position = /(\d+)\/(\d+)/.exec(set.firstElementChild?.querySelector(".tabular-nums")?.textContent ?? "")?.slice(1, 3).map(Number) ?? null;
  return {
    set: set.getAttribute("data-decision-set"), chip, heading, position, head: head.slice(0, 80),
    tabs: set.querySelectorAll("[data-question-tab]").length,
    marks: [...set.querySelectorAll("[data-question-tab]")].map((t) => t.textContent.trim().slice(0, 2)),
    ids: (set.getAttribute("data-waiting-set") ?? "").split(" ").filter(Boolean),
    shown: set.querySelector("[data-decision-card]")?.getAttribute("data-decision-card") ?? null,
    flash: set.querySelector("[data-decision-flash]")?.textContent ?? null,
  };
});

let failure = null;
try {
  const f = startChild("bun", ["tests/e2e/fixtures/fake-telegram-server.ts"], { env: { ...process.env }, log: join(logs, "fake-telegram.log"), ready: /FAKE_TELEGRAM (\{.*\})/ });
  fake = f.child;
  const fakeInfo = JSON.parse((await f.ready)[1]);
  const port = await freePort();
  const web = `http://127.0.0.1:${port}`;
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
  console.log(`fixture server pid=${backend.pid} port=${port}; fake telegram pid=${fake.pid}; ${LABEL}${OBSERVE ? " (observe)" : ""}`);
  const fx = fixtureApi(web);
  for (const [name, path] of [["alpha", alpha], ["beta", beta]]) await fx.post("/api/projects", { name, path });
  await until("bridge running", async () => (await fx.tg("bridge")).running, 30000);
  const main = (await fx.post("/api/project/__assistant__/chat/sessions", { providerId: "claude", title: "Assistant" })).data.id;
  await fx.post("/api/assistant/telegram/bind", { sessionId: main, chatId: String(OWNER) });
  const { data: { settings } } = await fx.api("/api/assistant/settings");
  await fx.api("/api/assistant/settings", { method: "PUT", body: JSON.stringify({ ...settings, timezone: "UTC", digest: { enabled: false, time: "08:00" } }) });
  const aTitle = "Alpha lead";
  const aChat = (await fx.post("/api/project/alpha/chat/sessions", { providerId: "claude", title: aTitle })).data.id;

  const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
  const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
  browser = await pw.chromium.launch({
    headless: true, args: ["--disable-dev-shm-usage"],
    ...(process.env.PPM_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PPM_PLAYWRIGHT_EXECUTABLE } : {}),
    ...(process.env.PPM_PLAYWRIGHT_CHANNEL ? { channel: process.env.PPM_PLAYWRIGHT_CHANNEL } : {}),
  });
  const pageErrors = [];
  const newPage = async (opts) => {
    const ctx = await browser.newContext({ serviceWorkers: "block", ...opts });
    await ctx.addInitScript(onboardingDone);
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => pageErrors.push(`${e}\n${e.stack ?? ""}`));
    return pg;
  };
  const deskA = await newPage({ viewport: { width: 1440, height: 900 } });

  const k = loopKit({ web, fx, tg: phone(fakeInfo.control), page: deskA, shotsDir: join(sandbox, "setup-shots"), owner: OWNER, record: (id, name) => console.log(`setup ${id}: ${name}`) });
  await mkdir(join(sandbox, "setup-shots"), { recursive: true });
  await k.managerTurn("alpha", aChat, "seed-alpha", [], "Keep the alpha release plan", "default");
  await k.idle(aChat);
  const s = { alpha, beta, main, aChat, aTitle };
  await step1(k, s);

  const cards = [];
  for (const [i, title] of TITLES.entries()) {
    const label = `ds-${i + 1}`;
    await k.managerTurn("alpha", aChat, label, [{ session: "report_to_assistant", args: { kind: "needs_decision", title, body: `Decision ${i + 1} of 7. OK goes ahead.` } }], `Report: ${title}`);
    const [rec] = await k.answered(label, 1);
    assert.equal(rec.isError, false, rec.text);
    await k.idle(aChat);
    cards.push(await k.cardOf("needs_decision", title));
  }
  assert.equal((await k.waiting()).total, 7);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const name = (id) => (id ? byId.get(id)?.title ?? id : null);
  ok("seven decisions from alpha's manager chat wait");

  // ---- The three surfaces, open side by side for the whole run ----
  await deskA.goto(`${web}/project/alpha/assistant`);
  const win = deskA.locator('[aria-roledescription="window"]', { has: deskA.locator("[data-assistant-body]") }).first();
  await win.waitFor({ timeout: 30000 });
  await win.locator('[role="toolbar"][aria-label$="title bar"]').dblclick({ position: { x: 120, y: 12 } });
  const deskM = await newPage({ viewport: { width: 1440, height: 900 } });
  await deskM.goto(`${web}/project/alpha?openChat=${encodeURIComponent(`claude/${aChat}`)}`);
  const mob = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mob.goto(`${web}/project/alpha/assistant`);

  const surfaces = {
    assistant: { page: deskA, root: () => deskA.locator("[data-assistant-body]:visible").first(), tap: false },
    manager: { page: deskM, root: () => deskM.locator("[data-manager-waiting-cards]:visible").first(), tap: false },
    phone: { page: mob, root: () => mob.locator("[data-assistant-body]:visible").first(), tap: true },
  };
  for (const [key, sf] of Object.entries(surfaces)) {
    await sf.root().waitFor({ timeout: 30000 });
    await sf.root().locator("[data-decision-set]").waitFor({ timeout: 30000 });
    if (key === "manager") {
      // A desktop's bar opens folded until something lands in it: unfold it.
      const toggle = sf.root().locator("[data-waiting-toggle]").first();
      if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    }
  }
  const setOf = (sf) => sf.root().locator("[data-decision-set]");
  const press = (sf, loc) => (sf.tap ? loc.tap() : loc.click());

  /** Every surface agrees on `n` waiting decisions, without a reload; `expectShown` per surface. */
  async function expectAll(step, n, expectShown = {}) {
    const read = {};
    for (const [key, sf] of Object.entries(surfaces)) {
      const fits = (r) => (n === 0
        ? !r.set && (key === "manager" ? true : r.chip === 0)
        : r.set === "open" && r.ids.length === n && r.heading === n && r.position?.[1] === n && r.tabs === (n > 1 ? n : 0)
          && r.chip === n && (!expectShown[key] || r.shown === expectShown[key]));
      let last = null;
      try {
        await until(`${step}: ${key} shows ${n}`, async () => {
          last = await readSurface(sf.root()).catch(() => ({ set: false, chip: 0 }));
          return fits(last);
        }, OBSERVE ? 2500 : 10000, 150);
      } catch {
        const why = `${step}: ${key} expected ${n} waiting${expectShown[key] ? ` showing "${name(expectShown[key])}"` : ""}, saw ${JSON.stringify({ ...last, shown: name(last?.shown), ids: last?.ids?.length })}`;
        if (!OBSERVE) throw new Error(why);
        observed.push(why);
        console.log(`OBSERVED ${why}`);
      }
      read[key] = last;
    }
    await Promise.all(Object.entries(surfaces).map(([key, sf]) => sf.page.screenshot({ path: join(shotsDir, `${LABEL}-${step}-${key}.png`) })));
    const line = Object.entries(read).map(([key, r]) => `${key}: ${r?.set ? `${r.heading} waiting, ${r.position?.join("/")}, ${r.tabs} tabs [${(r.marks ?? []).join(" ")}], chip ${r.chip}, shown "${name(r.shown)}"` : `no set, chip ${r?.chip ?? 0}`}`).join(" | ");
    console.log(`${step}: ${line}`);
    ok(`${step}: every surface counts ${n}${Object.keys(expectShown).length ? `, ${Object.entries(expectShown).map(([k2, id]) => `${k2} shows "${name(id)}"`).join(", ")}` : ""}`);
    return read;
  }

  const waitServer = (label, id) => until(`${label}: the server no longer lists it`, async () => (await fx.api("/api/assistant/cards/open")).data.cards.every((c) => c.id !== id), 20000);
  const openTab = async (sf, id) => {
    const tab = setOf(sf).locator(`[data-question-tab="${id}"]`);
    await tab.scrollIntoViewIfNeeded();
    await press(sf, tab);
    await until(`${id} shown`, async () => (await readSurface(sf.root())).shown === id, 5000);
  };
  const step = async (label, fn) => {
    try { await fn(); } catch (e) {
      if (!OBSERVE) throw e;
      observed.push(`${label}: ${e.message.split("\n")[0]}`);
      console.log(`OBSERVED ${label}: ${e.message.split("\n")[0]}`);
    }
  };

  const [c1, c2, c3, c4, c5, c6, c7] = cards.map((c) => c.id);
  await expectAll("0-seven", 7, { assistant: c1, manager: c1, phone: c1 });

  // 1. Answered in PPM: the Assistant window's Send this one.
  await step("1-ppm", async () => {
    const set = setOf(surfaces.assistant);
    await set.locator("[data-question-option]").first().click();
    await set.locator("[data-decision-send-one]").click();
    await waitServer("1-ppm", c1);
  });
  await expectAll("1-answered-in-ppm", 6, { assistant: c2, manager: c2, phone: c2 });
  if (!OBSERVE) {
    assert.match(await setOf(surfaces.assistant).locator("[data-decision-flash='sent']").innerText(), /Sent “Release 0\.26\.14 tonight\?”/);
    ok("1: the Assistant window says the card was sent, in one line");
  }

  // 2. Answered on Telegram while the phone has that card open: the phone moves to the next one.
  await step("2-telegram", async () => {
    await openTab(surfaces.phone, c4);
    const tg = phone(fakeInfo.control);
    const msg = await tg.waitFor(OWNER, "the fourth card", (m) => m.text.includes(TITLES[3]) && (m.reply_markup?.inline_keyboard?.flat() ?? []).some((x) => x.text.startsWith("OK")), 30000);
    await tg.pressLabel(OWNER, msg, "OK");
    await waitServer("2-telegram", c4);
  });
  await expectAll("2-answered-on-telegram", 5, { phone: c5, assistant: c2 });

  // 3. Dismissed from the manager chat's bar: the bar shows the next one.
  await step("3-dismiss", async () => {
    const set = setOf(surfaces.manager);
    assert.equal((await readSurface(surfaces.manager.root())).shown, c2, "the bar shows the first waiting card");
    await set.locator("button[title='Dismiss this card']").click();
    await waitServer("3-dismiss", c2);
  });
  await expectAll("3-dismissed", 4, { manager: c3, assistant: c3 });

  // 4. Closed by the server on its own while the Assistant window has it open.
  await step("4-closed", async () => {
    await openTab(surfaces.assistant, c6);
    const res = await fx.post("/__assistant-test/close-card", { id: c6 });
    assert.equal(res.ok, true, JSON.stringify(res));
    await waitServer("4-closed", c6);
  });
  await expectAll("4-closed-by-manager", 3, { assistant: c7 });

  // 5. The last three answered one by one (another device's OK): the set goes when none is left.
  for (const [i, id] of [c3, c5, c7].entries()) {
    await step(`5-${i + 1}`, async () => {
      await fx.post(`/api/assistant/cards/${id}/ok`, { draftSha256: null });
      await waitServer(`5-${i + 1}`, id);
    });
    await expectAll(`5-${i + 1}-answered-elsewhere`, 2 - i);
  }
  if (!OBSERVE) {
    assert.equal((await k.waiting()).total, 0);
    for (const sf of Object.values(surfaces)) assert.equal(await sf.page.locator("[data-decision-set]").count(), 0);
    ok("5: nothing waits, and no surface draws a set");
  }

  assert.deepEqual(pageErrors, [], `no page errors:\n${pageErrors.join("\n")}`);
} catch (e) {
  failure = e;
} finally {
  await browser?.close().catch(() => {});
  for (const child of [backend, fake]) {
    if (!child) continue;
    try { child.kill("SIGTERM"); } catch { /* gone */ }
  }
}

console.log(`\n${checks.length} checks passed (${LABEL})`);
if (observed.length) console.log(`${observed.length} observations:\n- ${observed.join("\n- ")}`);
console.log(`screenshots: ${shotsDir}\nlogs: ${logs}`);
if (failure) {
  console.error(`FAIL ${failure.stack ?? failure}`);
  process.exit(1);
}
process.exit(0);
