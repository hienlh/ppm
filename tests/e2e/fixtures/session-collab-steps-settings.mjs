// Session-collaboration e2e, part 3: Settings → Tools (9, each checked in a chat started after the
// change), the phone (10) and which notifications are sent (11).
import assert from "node:assert/strict";
import { resultOf } from "./session-collab-helpers.mjs";

/** Settings → Tools through the rail's Settings button (Ctrl+, is not taken while a composer has focus). */
async function openTools(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("button", { name: "Tools", exact: true }).first().click();
  await page.getByRole("switch", { name: /create_session/ }).waitFor({ timeout: 15000 });
}

async function closeSettings(page) {
  await page.getByRole("button", { name: "Close window" }).first().click();
  await page.getByRole("switch", { name: /create_session/ }).waitFor({ state: "detached", timeout: 5000 });
}

export async function runSettingsSteps(ctx) {
  const { page, kit, ck, ids } = ctx;
  const settings = async () => (await kit.api("/api/settings/ai")).data;

  // ── 9: create_session off hides it; asking off creates with no card; the wait minutes apply ──
  await kit.scenario("9", async () => {
    await ck.show(page, [ids.A]);
    await openTools(page);
    const createSwitch = page.getByRole("switch", { name: /create_session/ });
    assert.equal(await createSwitch.getAttribute("aria-checked"), "true");
    await createSwitch.click();
    await kit.until("create_session saved off", async () => (await settings()).ppm_tools?.create_session === false, 10000);
    await kit.shot(page, "09a-create-session-off");
    await closeSettings(page);

    const lister = await ck.newSession("claude", "Tool check");
    await ck.plan(lister.id, ck.steps({ list: true }, { say: "Listed my tools." }));
    let from = (await ck.calls()).length;
    await ck.show(page, [lister]);
    await ck.send(page, "Which session tools do you have?");
    const [list] = await ck.answered(from, 1, (c) => c.sessionId === lister.id);
    assert.deepEqual(list.text.split(",").sort(), ["send_to_session", "session_status"], `tools/list: ${list.text}`);

    await openTools(page);
    await page.getByRole("switch", { name: /create_session/ }).click();
    const ask = page.getByRole("switch", { name: /Ask before creating sessions/ });
    assert.equal(await ask.getAttribute("aria-checked"), "true");
    await ask.click();
    const minutes = page.locator('[data-session-collab-number="waitTimeoutMinutes"]');
    await minutes.fill("1");
    await minutes.press("Enter");
    await kit.until("settings saved", async () => {
      const s = await settings();
      return s.ppm_tools?.create_session === true && s.session_collab?.askBeforeCreate === false && s.session_collab?.waitTimeoutMinutes === 1;
    }, 10000);
    await kit.shot(page, "09b-ask-off-wait-one-minute");
    await closeSettings(page);

    const silent = await ck.newSession("claude", "Silent worker");
    await ck.show(page, [silent]);
    await ck.send(page, "Keep working until told. HOLD");
    await page.locator("text=Working on it, step by step.").first().waitFor({ timeout: 15000 });

    const lead = await ck.newSession("claude", "Fresh lead");
    await ck.plan(lead.id, ck.steps(
      { call: "create_session", args: { title: "No card child", task: "Say hello." } },
      { call: "send_to_session", args: { session_id: silent.id, message: "Anything yet?", wait: true } },
      { say: "Moving on." },
    ));
    from = (await ck.calls()).length;
    await ck.show(page, [lead]);
    await ck.send(page, "Start a child, then ask the silent worker.");
    const [create] = await ck.answered(from, 1, (c) => c.sessionId === lead.id, 15000);
    assert.equal(create.isError, false, create.text);
    assert.equal((await ck.route("/pending-cards")).count, 0, "no card was shown");
    assert.equal(await page.locator("[data-collab-approval]").count(), 0, "no card in the chat");
    const [, wait] = await ck.answered(from, 2, (c) => c.sessionId === lead.id, 120000);
    const took = wait.endedAt - wait.startedAt;
    assert.deepEqual(resultOf(wait)?.reply, { replied: false, reason: "timeout" }, wait.text);
    assert(took >= 55_000 && took <= 80_000, `the wait lasted the one minute set (${took} ms)`);
    await page.locator('[data-collab-no-reply="timeout"]:visible').first().waitFor({ timeout: 15000 });
    await kit.shot(page, "09c-no-card-and-one-minute-timeout");
    await ck.release(silent.id);
    kit.record("9: create_session off is gone from a new chat's tools/list; with asking off a new chat creates with no card; the wait times out after the 1 minute set", { waitMs: took });
  });
  // Back to the defaults for what follows, whatever 9 managed.
  await kit.api("/api/settings/ai", { method: "PUT", body: JSON.stringify({ ppm_tools: { create_session: true }, session_collab: { askBeforeCreate: true, waitTimeoutMinutes: 10 } }) });
  await ck.release();

  // ── 10: the phone ──
  await kit.scenario("10", async () => {
    const phone = await ctx.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" });
    await phone.addInitScript(ctx.pageInit);
    const p = ctx.current = await phone.newPage();
    try {
      await p.goto(`${ctx.web}/project/alpha`);
      const { B, A } = ids;
      await ck.show(p, [B]);
      const header = p.locator(`[data-from-session="${A.id}"] button:visible`).first();
      await header.waitFor({ timeout: 20000 });
      const hb = await header.boundingBox();
      assert(hb.height >= 44, `the bubble header is a 44px target (${hb.height})`);
      await p.screenshot({ path: `${ctx.artifacts}/10a-phone-bubble-header.png` });

      await p.getByRole("button", { name: "History", exact: true }).first().tap();
      const badge = p.locator(`[data-spawned-badge="${A.id}"]:visible`).first();
      await badge.waitFor({ timeout: 15000 });
      await badge.tap();
      const open = p.getByRole("button", { name: "Open the session that created it" });
      await open.waitFor({ timeout: 5000 });
      await p.locator("text=Created by Planner").first().waitFor();
      const ob = await open.boundingBox();
      assert(ob.height >= 44 && ob.y + ob.height <= 844, `the sheet's button is a reachable 44px target (${JSON.stringify(ob)})`);
      await p.screenshot({ path: `${ctx.artifacts}/10b-phone-badge-sheet.png` });

      await ck.show(p, [A]);
      const summary = p.locator("[data-linked-sessions-bar] button[aria-expanded]:visible").first();
      await summary.waitFor({ timeout: 15000 });
      assert.match(await summary.innerText(), /\d+ linked sessions/);
      assert.equal(await p.locator("[data-linked-sessions-bar] [data-linked-session]:visible").count(), 0, "collapsed: no chips until opened");
      await summary.tap();
      await p.locator("[data-linked-sessions-bar] [data-linked-session]:visible").first().waitFor({ timeout: 5000 });
      await p.screenshot({ path: `${ctx.artifacts}/10c-phone-bar-collapsed-then-open.png` });

      const lead = await ck.newSession("claude", "Phone lead");
      await ck.plan(lead.id, ck.steps({ call: "create_session", args: { title: "Phone child", task: "Say hi." } }, { say: "Done from the phone." }));
      const from = (await ck.calls()).length;
      await ck.show(p, [lead]);
      await ck.send(p, "Open a helper session.");
      const card = p.locator('[data-collab-approval="create"]:visible');
      await card.waitFor({ timeout: 20000 });
      const allow = card.getByRole("button", { name: "Allow once" });
      await allow.scrollIntoViewIfNeeded();
      const ab = await allow.boundingBox();
      assert(ab.height >= 44 && ab.y >= 0 && ab.y + ab.height <= 844, `Allow once is a reachable 44px target (${JSON.stringify(ab)})`);
      await p.screenshot({ path: `${ctx.artifacts}/10d-phone-approval-card.png` });
      await allow.tap();
      const [made] = await ck.answered(from, 1, (c) => c.sessionId === lead.id);
      assert.equal(made.isError, false, made.text);
      kit.record("10: phone — bubble header and badge sheet button are 44px, the badge opens Created by Planner on tap, the bar collapses to a summary, and the card's Allow once is reachable", { header: hb, sheetButton: ob, allow: ab });
    } finally {
      ctx.current = page;
      await phone.close();
    }
  });

  // ── 11: a notification for every card, none for an AI-created session finishing its turn ──
  await kit.scenario("11", async () => {
    const { published } = await ck.route("/ntfy");
    const titles = published.map((m) => `${m.title} | ${m.message}`);
    const has = (re) => titles.some((t) => re.test(t));
    assert(has(/^AI wants to open a session: Write the tests/), `create card notified: ${JSON.stringify(titles)}`);
    assert(has(/^Sessions reached their message limit \(20\/20\)/), "pair-limit card notified");
    const spawned = ["Write the tests", "Worker 1", "Claude helper", "Codex helper", "Phone child"];
    const finished = titles.filter((t) => /^Chat (completed|stopped)/.test(t));
    for (const title of spawned) {
      assert(!finished.some((t) => t.includes(`— ${title}`)), `no finished notification for AI-created "${title}": ${JSON.stringify(finished)}`);
    }
    assert(finished.some((t) => t.includes("— Release notes")), `a user-started session's turn still notifies: ${JSON.stringify(finished)}`);
    kit.record("11: the fake push channel got the create and pair-limit cards, and no finished-turn notification for any AI-created session (a user-started one still notifies)", { sent: titles.length, finished: finished.length });
  });
}
