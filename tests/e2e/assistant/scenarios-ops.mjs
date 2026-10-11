// Scenarios 12–20 of tests/e2e/assistant-e2e.mjs: the Assistant's git, schedule and tunnel tools,
// driven by scripted turns against the real routes. Every check reads the real side effect — the
// temp repository's log and its bare remote, PPM's own schedules table, the fake cloudflared's
// process — and what the page heard on /ws/global (`git:changed`, `schedules:changed`).
//
// Each scenario runs once per device (desktop, then phone) and names its files and schedules after
// the device, so the second pass never trips over what the first left behind.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The words a watch turn's refusal starts with (`WATCH_TURN_REFUSAL`). */
const WATCH_REFUSED = /Refused without asking the user: PPM started this turn on its own/;
const BYPASS_WARNING = "Every run executes every tool without asking, with nobody watching.";

export function plan(ctx) {
  const { paths, api, until, card, waitCard, answerCard, answered, send, turn, turnDone, turnOf, newSession, openAssistant, shot, record, parse } = ctx;
  const { alpha, remote, ppm } = paths;

  // ---------------------------------------------------------------- repository and database
  const git = (cwd, ...args) => ctx.command("git", ["-C", cwd, ...args]);
  const gitText = async (cwd, ...args) => (await git(cwd, ...args)).trim();
  const head = (cwd = alpha) => gitText(cwd, "rev-parse", "HEAD");
  const remoteHead = () => gitText(remote, "rev-parse", "main");
  /** The last commit's message as stored: the commit object after its headers, byte for byte. */
  const lastMessage = async () => {
    const object = Buffer.from(await git(alpha, "cat-file", "commit", "HEAD"));
    return object.subarray(object.indexOf("\n\n") + 2);
  };
  const write = (rel, text) => {
    mkdirSync(join(alpha, rel, ".."), { recursive: true });
    writeFileSync(join(alpha, rel), text);
  };
  /** PPM's own schedules table, read outside PPM. */
  const db = (sql, ...params) => {
    const handle = new DatabaseSync(join(ppm, "ppm.db"), { readOnly: true });
    try { return handle.prepare(sql).all(...params); } finally { handle.close(); }
  };
  const scheduleRow = (id) => db("SELECT * FROM schedules WHERE id = ?", id)[0] ?? null;
  const runsOf = (id) => db("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id", id);

  // ---------------------------------------------------------------- page helpers
  const heard = (dev, type) => dev.globalFrames.filter((f) => f.type === type).length;
  const heardGit = (dev) => dev.globalFrames.filter((f) => f.type === "git:changed" && f.data.projectName === "alpha").length;
  /** Set once; still there later means the page was never reloaded in between. */
  const markPage = (dev) => dev.page.evaluate(() => { window.__opsNoReload = true; });
  const pageKept = async (dev) => assert.equal(await dev.page.evaluate(() => window.__opsNoReload === true), true, "the page was not reloaded");
  /**
   * A desktop sidebar section, by its rail button — named only by its hover label, so found by
   * that label's text (the Assistant's window may sit over it).
   */
  async function sidebar(dev, label) {
    const button = dev.page.locator("aside button").filter({ has: dev.page.getByText(label, { exact: true }) }).first();
    await button.click({ timeout: 5000 }).catch(() => button.dispatchEvent("click"));
  }
  /** Text shown in the sidebar — on screen, not a copy some hidden element keeps. */
  const inSidebar = (dev, text) => dev.page.locator(`aside :text(${JSON.stringify(text)}):visible`);
  /** A schedule's row in Settings → Schedules: a button with its name and its Enabled/Disabled chip. */
  const settingsRow = (dev, name) => dev.page.locator("button", { hasText: name }).filter({ hasText: /Enabled|Disabled/ });
  const noCard = async (dev, what) => assert.equal(await card(dev).count(), 0, `${what}: no card`);

  /**
   * A turn whose one call shows a card: inspected, then answered with `verb`. A window opened by
   * an earlier step (Settings) may sit over the Assistant's card on a desktop; the click then
   * goes to the button itself, as a tap on the card's own button would.
   */
  async function decide(dev, label, op, message, sessionId, verb, inspect) {
    await send(dev, label, [op], message, sessionId);
    const shown = await waitCard(dev);
    if (inspect) await inspect(shown.text);
    if (dev.kind === "phone") await answerCard(dev, verb);
    else {
      const button = card(dev).getByRole("button", { name: verb, exact: true });
      await button.click({ timeout: 5000 }).catch(() => button.dispatchEvent("click"));
    }
    const [rec] = await answered(label, 1);
    await turnDone(dev, label);
    return { text: shown.text, rec };
  }
  /** A fresh Assistant session whose first turn runs `ops`; answers its records and the session id. */
  async function firstTurn(dev, label, ops, message) {
    await openAssistant(dev);
    await newSession(dev);
    const recs = await turn(dev, label, ops, message);
    return { recs, sessionId: (await turnOf(label)).sessionId };
  }

  // ---------------------------------------------------------------- 12. reads ask nothing
  async function s12(dev) {
    const mine = `ops/${dev.name}.txt`;
    write(mine, `tracked ${dev.name}\ns12 edit ${dev.name}\n`);
    const { recs: [status, log, diff, branches] } = await firstTurn(dev, `s12-read-${dev.name}`, [
      { mcp: "git_status", args: { project: "alpha" } },
      { mcp: "git_log", args: { project: "alpha", max: 5 } },
      { mcp: "git_diff", args: { project: "alpha", file: mine } },
      { mcp: "git_branches", args: { project: "alpha" } },
    ], `What changed in alpha? (${dev.name})`);
    for (const r of [status, log, diff, branches]) assert.equal(r.isError, false, r.text);
    await noCard(dev, "reading git");
    const s = parse(status);
    assert.equal(s.branch.name, "main");
    assert.equal(s.branch.upstream, "origin/main");
    assert.ok(s.files.some((f) => f.path === mine && f.unstaged), `git_status lists ${mine} as changed`);
    assert.ok(parse(log).commits.some((c) => c.subject === "chore: alpha starts here"), "git_log reaches the first commit");
    assert.match(parse(diff).diff, new RegExp(`\\+s12 edit ${dev.name}`), "git_diff shows the edit");
    assert.equal(parse(branches).current.name, "main");
    assert.ok(parse(branches).remote.some((b) => b.name === "origin/main"), "the remote branch is named");
    // A remote is named, never shown by where it lives.
    for (const r of [status, log, diff, branches]) {
      assert.ok(!/alpha-remote|file:\/\//i.test(r.text), `no remote URL in ${r.op.mcp}`);
    }
    record("s12", dev.name, "git_status / git_log / git_diff / git_branches answer without a card: branch, upstream, the edited file and its diff, no remote URL");
  }

  // ---------------------------------------------------------------- 13. stage, then commit verbatim
  async function s13(dev) {
    const file = `ops/s13-${dev.name}.txt`;
    const name = `s13-${dev.name}.txt`;
    const message = `feat(e2e): <b>&amp; \`tick\` ‮evil‬ (${dev.name})`;
    const { sessionId } = await firstTurn(dev, `s13-start-${dev.name}`, [], `Let's commit something (${dev.name})`);
    write(file, `new in s13 on the ${dev.name}\n`);
    if (dev.kind === "desktop") {
      await sidebar(dev, "Git");
      await inSidebar(dev, name).first().waitFor({ timeout: 20000 });
    }
    await markPage(dev);
    const gitBefore = heardGit(dev);

    await decide(dev, `s13-stage-${dev.name}`, { mcp: "git_stage", args: { project: "alpha", files: [file] } }, `Stage ${file}`, sessionId, "Allow", (text) => {
      assert.match(text, /Stage 1 file in "alpha" for the next commit/);
      assert.ok(text.includes(file), "the card names the file");
    });
    const staged = await gitText(alpha, "diff", "--cached", "--name-only");
    assert.ok(staged.split("\n").includes(file), "the file is staged in the repository");

    const before = await head();
    const { text, rec } = await decide(dev, `s13-commit-${dev.name}`, { mcp: "git_commit", args: { project: "alpha", message } }, "Commit it", sessionId, "Allow", async (shown) => {
      assert.match(shown, /Commit 1 staged file in "alpha"/);
      assert.ok(shown.indexOf(file) >= 0 && shown.indexOf(file) < shown.indexOf("Message:"), "the files come before the message");
      assert.ok(shown.includes("feat(e2e): <b>&amp; `tick`"), "the message is shown as written");
      const markers = await card(dev).locator("[data-hidden-character]").allInnerTexts();
      assert.ok(markers.some((m) => m.includes("U+202E")), `the bidi override is shown as a marker (${markers.join(" ")})`);
      if (dev.kind === "desktop") await shot(dev, "s13-commit-card");
    });
    assert.equal(rec.isError, false, rec.text);
    assert.notEqual(await head(), before, "a commit was made");
    assert.deepEqual(await lastMessage(), Buffer.from(`${message}\n`), "the commit message is byte for byte the one on the card");
    assert.equal(await gitText(alpha, "show", "--name-only", "--format=", "HEAD"), file, "the commit holds exactly the staged file");
    void text;
    await until("the page heard git:changed for the stage and the commit", () => heardGit(dev) >= gitBefore + 2, 10000);
    if (dev.kind === "desktop") {
      await until("Source Control dropped the committed file", async () => (await inSidebar(dev, name).count()) === 0, 15000);
      await shot(dev, "s13-source-control-after-commit");
    }
    await pageKept(dev);
    record("s13", dev.name, "git_stage then git_commit: files listed before the verbatim message, the bidi override shown as a marker; the commit is byte-exact and the open page hears git:changed with no reload");
  }

  // ---------------------------------------------------------------- 14. discard, then undo
  async function s14(dev) {
    const tracked = `ops/${dev.name}.txt`;
    const fresh = `ops/s14-new-${dev.name}.txt`;
    const editedText = `tracked ${dev.name}\ns14 edit ${dev.name}\n`;
    write(tracked, editedText);
    write(fresh, `s14 new file on the ${dev.name}\n`);
    const { sessionId } = await firstTurn(dev, `s14-start-${dev.name}`, [], `Throw away my edits (${dev.name})`);
    const gitBefore = heardGit(dev);
    const { rec } = await decide(dev, `s14-discard-${dev.name}`, { mcp: "git_discard", args: { project: "alpha", files: [tracked, fresh] } }, "Discard both", sessionId, "Allow", (text) => {
      assert.match(text, /Discard the unstaged changes to 2 files in "alpha"/);
      assert.ok(text.includes("PPM keeps a copy for one day"), "the card says the copy is kept for a day");
      assert.ok(text.includes(`${fresh}  (new file — deleted)`), "the new file is marked as deleted");
    });
    assert.equal(rec.isError, false, rec.text);
    const undoId = parse(rec).undo?.id;
    assert.ok(undoId, "the discard can be undone");
    assert.equal(existsSync(join(alpha, fresh)), false, "the new file is gone");
    assert.equal(readFileSync(join(alpha, tracked), "utf8"), `tracked ${dev.name}\n`, "the edit is gone");

    const [status] = await turn(dev, `s14-status-${dev.name}`, [{ mcp: "git_status", args: { project: "alpha" } }], "Can I still undo that?", sessionId);
    assert.ok(parse(status).undoableDiscards.some((d) => d.id === undoId), "git_status lists the discard as undoable");

    const { rec: undone } = await decide(dev, `s14-undo-${dev.name}`, { mcp: "git_undo", args: { project: "alpha", kind: "discard", id: undoId } }, "Undo the discard", sessionId, "Allow", (text) => {
      assert.match(text, /Undo a discard in "alpha": write back 2 files/);
    });
    assert.equal(undone.isError, false, undone.text);
    assert.equal(readFileSync(join(alpha, fresh), "utf8"), `s14 new file on the ${dev.name}\n`, "the new file is back");
    assert.equal(readFileSync(join(alpha, tracked), "utf8"), editedText, "the edit is back");
    await until("the page heard git:changed for the discard and the undo", () => heardGit(dev) >= gitBefore + 2, 10000);
    // Leave the tree as it was: the edit stays (s15 does not mind), the new file goes.
    rmSync(join(alpha, fresh));
    record("s14", dev.name, "git_discard of a new and an edited file (card: 'kept for one day', '(new file — deleted)') removes both; git_status lists the Undo and git_undo kind=discard writes both back", { undoId });
  }

  // ---------------------------------------------------------------- 15. push denied, push, pull
  async function s15(dev) {
    const file = `ops/s15-${dev.name}.txt`;
    write(file, `s15 on the ${dev.name}\n`);
    await git(alpha, "add", "--", file);
    await git(alpha, "commit", "-q", "-m", `test: s15 commit (${dev.name})`);
    const local = await head();
    const remoteBefore = await remoteHead();
    assert.notEqual(local, remoteBefore, "there is something to push");
    const { sessionId } = await firstTurn(dev, `s15-start-${dev.name}`, [], `Sync alpha (${dev.name})`);

    const push = { mcp: "git_sync", args: { project: "alpha", action: "push" } };
    const denied = await decide(dev, `s15-push-deny-${dev.name}`, push, "Push it", sessionId, "Deny", (text) => {
      assert.match(text, /Push \d+ commits? of main to origin\/main/);
      assert.ok(text.includes("Never — PPM does not force push"), "the card says there is no force");
    });
    assert.equal(denied.rec.isError, true);
    assert.equal(await remoteHead(), remoteBefore, "Deny: the bare remote did not move");

    const allowed = await decide(dev, `s15-push-allow-${dev.name}`, push, "Push it, really", sessionId, "Allow");
    assert.equal(allowed.rec.isError, false, allowed.rec.text);
    assert.equal(await remoteHead(), local, "Allow: the bare remote has the commit");
    assert.equal(parse(allowed.rec).branch.ahead, 0);

    const pulled = await decide(dev, `s15-pull-${dev.name}`, { mcp: "git_sync", args: { project: "alpha", action: "pull" } }, "Pull, though nothing is new", sessionId, "Allow", (text) => {
      assert.match(text, /Pull origin\/main into main in "alpha"/);
    });
    assert.equal(pulled.rec.isError, false, pulled.rec.text);
    assert.equal(parse(pulled.rec).pulled, true);
    assert.equal(await head(), local, "nothing new came in");
    for (const r of [denied.rec, allowed.rec, pulled.rec]) assert.ok(!/alpha-remote|file:\/\//i.test(r.text), "no remote URL");
    record("s15", dev.name, "git_sync push: Deny leaves the bare remote as it was, Allow puts the commit there (card: never force); pull with nothing new succeeds");
  }

  // ---------------------------------------------------------------- 16. a container project
  async function s16(dev) {
    const { recs: [list, api_, outside] } = await firstTurn(dev, `s16-beta-${dev.name}`, [
      { mcp: "git_status", args: { project: "beta" } },
      { mcp: "git_status", args: { project: "beta", repo: "api" } },
      { mcp: "git_status", args: { project: "beta", repo: "../alpha" } },
    ], `Which repositories are in beta? (${dev.name})`);
    await noCard(dev, "reading a container project");
    assert.equal(list.isError, false, list.text);
    assert.deepEqual(parse(list).repositories.map((r) => r.relative).sort(), ["api", "web"], "no repo: the repositories are listed");
    assert.equal(api_.isError, false, api_.text);
    assert.equal(parse(api_).repository, "api");
    assert.equal(parse(api_).branch.name, "main");
    assert.equal(outside.isError, true, "a repo outside the project is refused");
    assert.match(outside.text, /api/);
    assert.match(outside.text, /web/);
    record("s16", dev.name, "beta holds api and web: no repo lists them, repo=api answers for api, a repo outside the project is refused naming both");
  }

  // ---------------------------------------------------------------- 17. a schedule's whole life
  async function s17(dev) {
    const name = `E2E hello ${dev.name}`;
    const prompt = `Say hello from the ${dev.name} schedule <b>&amp; \`now\``;
    const { sessionId } = await firstTurn(dev, `s17-start-${dev.name}`, [], `Let's set up a schedule (${dev.name})`);
    if (dev.kind === "desktop") {
      const [opened] = await turn(dev, `s17-settings-${dev.name}`, [{ mcp: "ui_open_tab", args: { project: "alpha", kind: "settings", target: { section: "schedules" } } }], "Show me Schedules", sessionId);
      assert.equal(opened.isError, false, opened.text);
      await dev.page.getByText("Periodically wake Claude to work on a project unattended.").first().waitFor({ timeout: 20000 });
    }
    await markPage(dev);
    const events = () => heard(dev, "schedules:changed");

    // Create, with no mode: the Settings form's default, bypass, said on the card.
    let n = events();
    const created = await decide(dev, `s17-create-${dev.name}`, { mcp: "schedule_save", args: { name, cron: "0 9 * * 1-5", project: "alpha", prompt } }, "Every weekday at 9, say hello", sessionId, "Allow", (text) => {
      assert.match(text, new RegExp(`Create the schedule "${name}" in "alpha"`));
      assert.match(text, /Next runs\n[^\n]+, [^\n]+, [^\n]+ \([^)\n]+\)/, "three next runs with their time zone");
      assert.ok(text.includes("Bypass permissions"), "the mode is named");
      assert.ok(text.includes(BYPASS_WARNING), "the bypass warning");
      assert.ok(text.includes(prompt), "the prompt in full");
      if (dev.kind === "desktop") return shot(dev, "s17-create-card");
    });
    assert.equal(created.rec.isError, false, created.rec.text);
    const id = parse(created.rec).schedule.id;
    assert.equal(scheduleRow(id)?.permission_mode, "bypassPermissions", "stored in bypass, as the card said");
    assert.equal(scheduleRow(id)?.prompt, prompt, "the prompt stored as written");
    await until("schedules:changed after the create", () => events() > n, 10000);
    if (dev.kind === "desktop") await settingsRow(dev, name).first().waitFor({ timeout: 5000 });

    // Pause.
    n = events();
    const paused = await decide(dev, `s17-pause-${dev.name}`, { mcp: "schedule_save", args: { id, enabled: false } }, "Pause it", sessionId, "Allow", (text) => {
      assert.match(text, new RegExp(`Pause the schedule "${name}" in "alpha"`));
    });
    assert.equal(paused.rec.isError, false, paused.rec.text);
    assert.equal(scheduleRow(id)?.enabled, 0, "paused in the table");
    await until("schedules:changed after the pause", () => events() > n, 10000);
    if (dev.kind === "desktop") {
      await until("the Settings row says Disabled", async () => /Disabled/.test(await settingsRow(dev, name).first().innerText()), 5000);
    }

    // Run now: Deny starts nothing.
    const runNow = { mcp: "schedule_run_now", args: { id } };
    const deniedRun = await decide(dev, `s17-run-deny-${dev.name}`, runNow, "Run it now", sessionId, "Deny", (text) => {
      assert.match(text, new RegExp(`Run the schedule "${name}" now in "alpha"`));
      assert.ok(text.includes(prompt), "the prompt that would run");
    });
    assert.equal(deniedRun.rec.isError, true);
    assert.deepEqual(runsOf(id), [], "Deny: no run");

    // Run now, allowed: a scripted turn answers (no model), and its end is announced too.
    await ctx.scriptMatch(`s17-scheduled-${dev.name}`, [{ text: `Scheduled hello from the ${dev.name}.` }], prompt);
    n = events();
    const ran = await decide(dev, `s17-run-allow-${dev.name}`, runNow, "Run it now, really", sessionId, "Allow");
    assert.equal(ran.rec.isError, false, ran.rec.text);
    const runId = parse(ran.rec).runId;
    const run = await until("the run finished", () => runsOf(id).find((r) => r.id === runId && r.status !== "running"), 30000);
    assert.equal(run.status, "done", run.error ?? "");
    assert.ok(String(run.output_truncated).includes(`Scheduled hello from the ${dev.name}.`), "the scripted turn's words are the run's output");
    // One from the run-now route, one once the run ended.
    await until("schedules:changed for the run-now and for the run's end", () => events() >= n + 2, 10000);

    // Delete.
    n = events();
    const deleted = await decide(dev, `s17-delete-${dev.name}`, { mcp: "schedule_delete", args: { id } }, "Delete it", sessionId, "Allow", (text) => {
      assert.match(text, new RegExp(`Delete the schedule "${name}" in "alpha" and its run history`));
      assert.match(text, /1 recorded run deleted with it/);
    });
    assert.equal(deleted.rec.isError, false, deleted.rec.text);
    assert.equal(scheduleRow(id), null, "gone from the table");
    assert.deepEqual(runsOf(id), [], "its run history went with it");
    await until("schedules:changed after the delete", () => events() > n, 10000);
    if (dev.kind === "desktop") {
      await until("the Settings list dropped it", async () => (await settingsRow(dev, name).count()) === 0, 5000);
      await shot(dev, "s17-after-delete");
    }
    await pageKept(dev);
    record("s17", dev.name, "schedule_save (no mode: bypass warning, 3 next runs with zone, prompt verbatim), pause, run_now Deny (no run) and Allow (scripted run done, its end announced), delete — the table and the open Settings follow with no reload", { scheduleId: id, runId });
  }

  // ---------------------------------------------------------------- 18. forwards with the fake cloudflared
  async function s18(dev) {
    const junk = createHttpServer((_req, res) => res.end("junk"));
    await new Promise((r) => junk.listen(0, "127.0.0.1", r));
    const port = junk.address().port;
    try {
      const { sessionId } = await firstTurn(dev, `s18-start-${dev.name}`, [], `Forward my dev server (${dev.name})`);
      if (dev.kind === "desktop") {
        await sidebar(dev, "Port Forwarding");
        await dev.page.locator('[data-testid="port-forwarding-list"]').waitFor({ timeout: 15000 });
      }

      const started = await decide(dev, `s18-start-forward-${dev.name}`, { mcp: "port_forward_start", args: { port } }, `Forward port ${port}`, sessionId, "Allow", (text) => {
        assert.ok(text.includes(`Put localhost:${port} on the public internet`));
        assert.ok(text.includes("PPM's login does not protect it"), "the card says who can reach it");
      });
      assert.equal(started.rec.isError, false, started.rec.text);
      const startedAt = Date.now();
      assert.match(parse(started.rec).url, /^https:\/\/e2e-\d+\.trycloudflare\.com$/, "the fake cloudflared's address");

      const [status] = await turn(dev, `s18-status-${dev.name}`, [{ mcp: "tunnels_status" }], "What is forwarded?", sessionId);
      const s = parse(status);
      assert.ok("tailscale" in s, "tunnels_status says where Tailscale stands");
      assert.ok(!/tokenMasked|certState/.test(status.text), "no token or certificate state");
      const own = s.forwards.find((f) => f.port === port && f.ownedByThisPpm);
      assert.ok(own, `the forward is listed as this PPM's (${JSON.stringify(s.forwards.map((f) => [f.pid, f.port, f.ownedByThisPpm]))})`);
      const pid = own.pid;
      if (dev.kind === "desktop") {
        const row = dev.page.locator('[data-testid="forward-row"]', { hasText: `:${port}` }).first();
        // The panel polls every 10 s, and each poll's process scan may take its full 12 s on a
        // loaded host before falling back to this PPM's own forwards.
        await row.waitFor({ timeout: Math.max(1000, 25000 - (Date.now() - startedAt)) });
        await shot(dev, "s18-port-forwarding-panel");
      }

      // Refused before any card: a pid PPM did not start, and PPM's own port.
      const [foreign, ownPort] = await turn(dev, `s18-refused-${dev.name}`, [
        { mcp: "port_forward_stop", args: { pid: ctx.backendPid() } },
        { mcp: "port_forward_start", args: { port: ctx.port } },
      ], "Stop that other process, and forward PPM itself", sessionId);
      await noCard(dev, "refused forwards");
      assert.equal(foreign.isError, true);
      assert.match(foreign.text, /is not a forward this PPM started/);
      assert.equal(ownPort.isError, true);
      assert.match(ownPort.text, /is PPM's own port/);

      const stopped = await decide(dev, `s18-stop-${dev.name}`, { mcp: "port_forward_stop", args: { port } }, `Stop forwarding ${port}`, sessionId, "Allow", (text) => {
        assert.ok(text.includes(`Stop forwarding localhost:${port}`));
        assert.ok(text.includes(String(pid)), "the card names the pid");
      });
      assert.equal(stopped.rec.isError, false, stopped.rec.text);
      assert.equal(parse(stopped.rec).outcome, "stopped");
      await until(`the fake cloudflared ${pid} is gone`, () => { try { process.kill(pid, 0); return false; } catch { return true; } }, 10000);
      record("s18", dev.name, "port_forward_start (card: PPM's login does not protect it) runs the fake cloudflared, listed as this PPM's (and in the open panel); a foreign pid and PPM's own port are refused without a card; port_forward_stop ends exactly that process", { port, pid });
    } finally {
      junk.close();
    }
  }

  // ---------------------------------------------------------------- 19. the public link
  async function s19(dev) {
    // Start from on, whatever an earlier pass left.
    const tunnel = (await api("/__assistant-test/tunnel-config")).tunnel ?? {};
    await api("/__assistant-test/tunnel-config", { method: "POST", body: JSON.stringify({ ...tunnel, enabled: true }) });
    const { recs: [before], sessionId } = await firstTurn(dev, `s19-status-${dev.name}`, [{ mcp: "tunnels_status" }], `Is PPM public? (${dev.name})`);
    assert.equal(parse(before).publicLink.enabled, true);
    assert.equal(parse(before).auth.enabled, false, "this fixture runs with the login off");

    const off = { mcp: "public_link_set", args: { enabled: false } };
    const denied = await decide(dev, `s19-off-deny-${dev.name}`, off, "Switch the public link off", sessionId, "Deny", (text) => {
      assert.match(text, /Switch off PPM's public address/);
      assert.ok(text.includes("Telegram's Open in PPM buttons stop working"), "the card says what stops working");
    });
    assert.equal(denied.rec.isError, true);
    assert.equal((await api("/__assistant-test/tunnel-config")).tunnel.enabled, true, "Deny: still on");

    const allowed = await decide(dev, `s19-off-allow-${dev.name}`, off, "Switch it off, really", sessionId, "Allow");
    assert.equal(allowed.rec.isError, false, allowed.rec.text);
    assert.deepEqual([parse(allowed.rec).outcome, parse(allowed.rec).reload], ["switched", "no-supervisor"]);

    const [on] = await turn(dev, `s19-on-${dev.name}`, [{ mcp: "public_link_set", args: { enabled: true } }], "Switch it back on", sessionId);
    await noCard(dev, "switching on with the login off");
    assert.equal(on.isError, true, "refused: PPM's login is off");
    assert.match(on.text, /login is off/);
    assert.equal((await api("/__assistant-test/tunnel-config")).tunnel.enabled, false, "still off");
    assert.equal(existsSync(join(ppm, ".supervisor-cmd")), false, "no supervisor was told anything");
    record("s19", dev.name, "public_link_set off: the card says Telegram's Open in PPM stops working; Deny keeps it on, Allow saves it (no supervisor); switching on with the login off is refused without a card; no .supervisor-cmd");
  }

  // ---------------------------------------------------------------- 20. a watch turn changes nothing
  async function s20(dev) {
    const file = `ops/s20-${dev.name}.txt`;
    write(file, `s20 on the ${dev.name}\n`);
    await git(alpha, "add", "--", file);
    const before = await head();
    const schedule = (await api("/api/schedules", { method: "POST", body: JSON.stringify({ name: `S20 ${dev.name}`, cron_expr: "0 3 * * *", project_path: alpha, prompt: "s20 must not run", permission_mode: "default" }) })).data;
    try {
      // An ordinary chat in alpha, running for a few seconds.
      const label = `s20-target-${dev.name}`;
      const draft = (await api("/api/project/alpha/chat/sessions", { method: "POST", body: JSON.stringify({ providerId: "claude", title: `S20 target ${dev.name}` }) })).data.id;
      // Long enough to still be running when the Assistant, opened next, sets its watch.
      await ctx.script(label, [{ sleep: 15000 }, { text: "Target finished." }], draft);
      const socket = new WebSocket(`${ctx.web.replace("http", "ws")}/ws/project/alpha/chat/${draft}?providerId=claude`);
      await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
      socket.send(JSON.stringify({ type: "message", content: `S20 target job (${dev.name})`, permissionMode: "default", clientMessageId: crypto.randomUUID() }));
      const target = await until(`${label} started`, () => turnOf(label), 30000);
      socket.close();

      const { recs: [watch], sessionId } = await firstTurn(dev, `s20-watch-${dev.name}`, [{ mcp: "chat_watch", args: { project: "alpha", sessionId: target.sessionId, providerId: "claude" } }], `Tell me when that chat finishes (${dev.name})`);
      assert.equal(parse(watch).watching, true, watch.text);
      const wakeLabel = `s20-wake-${dev.name}`;
      await ctx.script(wakeLabel, [
        { mcp: "git_commit", args: { project: "alpha", message: "s20: must not be committed" } },
        { mcp: "schedule_run_now", args: { id: schedule.id } },
      ], sessionId);
      const wakeFrom = Date.now();
      const [commit, runNow] = await answered(wakeLabel, 2, 60000);
      const wake = await turnOf(wakeLabel);
      assert.match(wake.message, /\[PPM\] News about a chat you asked me to watch/, "the turn PPM started on its own");
      for (const r of [commit, runNow]) {
        assert.equal(r.isError, true);
        assert.match(r.text, WATCH_REFUSED);
      }
      await turnDone(dev, wakeLabel);
      await noCard(dev, "a watch turn");
      assert.ok(!dev.frames.some((f) => f.type === "approval_request" && f.at >= wakeFrom), "no card was sent to the page");
      assert.equal(await head(), before, "nothing was committed");
      assert.deepEqual(runsOf(schedule.id), [], "the schedule did not run");
      record("s20", dev.name, "a watch turn's git_commit and schedule_run_now are refused with the watch-turn refusal, no card, the repository and the schedule unchanged");
    } finally {
      await api(`/api/schedules/${schedule.id}`, { method: "DELETE" });
      await git(alpha, "rm", "-q", "--cached", "--", file);
      rmSync(join(alpha, file), { force: true });
    }
  }

  return [
    ["s12", s12], ["s13", s13], ["s14", s14], ["s15", s15], ["s16", s16],
    ["s17", s17], ["s18", s18], ["s19", s19], ["s20", s20],
  ];
}

/** The repositories the scenarios act on: alpha with a first commit and a bare remote, beta a container of two. */
export async function setupRepositories({ command, alpha, beta, remote }) {
  const git = (cwd, ...args) => command("git", ["-C", cwd, ...args]);
  // Local settings only: the server runs git with a scratch HOME (no identity), and the user's own
  // global settings (hooks, signing, line endings) must not change what the repository holds.
  const local = async (dir) => {
    for (const [k, v] of [["user.name", "PPM E2E"], ["user.email", "e2e@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["core.hooksPath", ".git/hooks"]]) {
      await git(dir, "config", k, v);
    }
  };
  const init = async (dir) => {
    await command("git", ["init", "-q", "-b", "main", dir]);
    await local(dir);
  };
  await init(alpha);
  writeFileSync(join(alpha, ".gitignore"), "data/\n");
  mkdirSync(join(alpha, "ops"), { recursive: true });
  for (const dev of ["desktop", "phone"]) writeFileSync(join(alpha, "ops", `${dev}.txt`), `tracked ${dev}\n`);
  await git(alpha, "add", "-A");
  await git(alpha, "commit", "-q", "-m", "chore: alpha starts here");
  await command("git", ["init", "-q", "--bare", "-b", "main", remote]);
  await git(alpha, "remote", "add", "origin", pathToFileUrl(remote));
  await git(alpha, "push", "-q", "-u", "origin", "main");
  for (const sub of ["api", "web"]) {
    const dir = join(beta, sub);
    mkdirSync(dir, { recursive: true });
    await init(dir);
    writeFileSync(join(dir, "README.md"), `# ${sub}\n`);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", `chore: ${sub} starts here`);
  }
}

const pathToFileUrl = (p) => `file:///${p.replace(/\\/g, "/").replace(/^\/+/, "")}`;
