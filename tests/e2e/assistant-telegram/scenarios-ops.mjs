// Scenarios 23–27: the Assistant's git, schedule and tunnel tools asked for from Telegram. A card
// whose deciding part fits gets Allow there; one too long gets only Deny and Open in PPM; and no
// answer — tool result, card or reply — carries a named tunnel's token. Every check reads the real
// side effect: the temp repository's log, PPM's schedules, what the PPM page heard on /ws/global.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buttonsOf, labelsOf, until } from "./harness.mjs";
import { boundSessionOf } from "./scenarios-sync.mjs";

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (s) => { out += s; });
    child.stderr.on("data", (s) => { out += s; });
    child.on("error", reject);
    child.on("exit", (code) => (code ? reject(new Error(`git ${args.join(" ")} exited ${code}: ${out}`)) : resolve(out)));
  });
}

/**
 * alpha as a repository with one commit. Local settings only: the server runs git with a scratch
 * HOME (no identity), and the user's own global settings must not change what it holds.
 */
export async function setupRepository(alpha) {
  await new Promise((resolve, reject) => {
    const child = spawn("git", ["init", "-q", "-b", "main", alpha], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => (code ? reject(new Error(`git init exited ${code}`)) : resolve()));
  });
  for (const [k, v] of [["user.name", "PPM E2E"], ["user.email", "e2e@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["core.hooksPath", ".git/hooks"]]) {
    await git(alpha, "config", k, v);
  }
  await git(alpha, "add", "-A");
  await git(alpha, "commit", "-q", "-m", "chore: alpha starts here");
}

const done = (ctx, label, timeout = 30000) =>
  until(`${label} answered`, async () => { const r = await ctx.fx.recordsOf(label); return r.length >= 1 && r.every((c) => c.done) && r; }, timeout);

/** The chat's own Assistant session, made by its first message. */
async function sessionFor(ctx, chat, label) {
  await ctx.fx.script(label, [{ text: `${label} ready.` }], { match: `${label} hello` });
  await ctx.tg.send(chat, `${label} hello`);
  await ctx.tg.waitText(chat, `${label} ready.`);
  return (await boundSessionOf(ctx, chat)).sessionId;
}

/** What a device's page hears on /ws/global from now on (attached before its next navigation). */
function listenGlobal(dev) {
  if (dev.globalFrames) return;
  dev.globalFrames = [];
  dev.page.on("websocket", (ws) => {
    if (!/\/ws\/global(?:\?|$)/.test(ws.url())) return;
    ws.on("framereceived", (f) => { try { const data = JSON.parse(String(f.payload)); dev.globalFrames.push({ type: data.type, at: Date.now(), data }); } catch { /* not JSON */ } });
  });
}

/** 23. A short commit card on Telegram: files and message, Allow — committed, PPM's copy closes. */
async function s23(ctx, chat, desk) {
  const { fx, tg, kit, paths } = ctx;
  const { alpha } = paths;
  const session = await sessionFor(ctx, chat, "S23");
  listenGlobal(desk);
  await kit.openLink(desk, `${ctx.web}/assistant?session=claude/${session}`);
  writeFileSync(join(alpha, "s23-telegram.txt"), "committed from Telegram\n");
  await git(alpha, "add", "--", "s23-telegram.txt");
  const before = (await git(alpha, "rev-parse", "HEAD")).trim();
  const message = "chore: S23 commit from Telegram";
  await fx.script("s23-commit", [{ mcp: "git_commit", args: { project: "alpha", message } }], { match: "S23 commit" });
  const heardBefore = desk.globalFrames.filter((f) => f.type === "git:changed").length;
  await tg.send(chat, `S23 commit với message "${message}"`);

  const card = await tg.waitFor(chat, "commit card", (m) => m.text.includes(message) && buttonsOf(m).length > 0);
  assert.ok(card.text.includes("s23-telegram.txt"), "the card lists the staged file");
  assert.ok(card.text.indexOf("s23-telegram.txt") < card.text.lastIndexOf(message), "the files come before the message");
  assert.deepEqual(labelsOf(card), ["Allow", "Deny"], "a short commit may be allowed from Telegram");
  const ppmCard = kit.card(desk);
  await ppmCard.waitFor({ timeout: 20000 });
  assert.ok((await ppmCard.innerText()).includes(message), "PPM shows the same card");
  await kit.shot(desk, "s23-commit-card-in-ppm");

  const n = (await tg.answers()).length;
  await tg.pressLabel(chat, card, "Allow");
  assert.equal((await tg.answerAfter(n)).text, "Allowed.");
  const [rec] = await done(ctx, "s23-commit");
  assert.equal(rec.isError, false, rec.text);
  assert.notEqual((await git(alpha, "rev-parse", "HEAD")).trim(), before, "a commit was made");
  const object = await git(alpha, "cat-file", "commit", "HEAD");
  assert.equal(object.slice(object.indexOf("\n\n") + 2), `${message}\n`, "with the message on the card");
  assert.equal((await git(alpha, "show", "--name-only", "--format=", "HEAD")).trim(), "s23-telegram.txt");
  await until("the PPM page heard git:changed", () => desk.globalFrames.filter((f) => f.type === "git:changed" && f.data.projectName === "alpha").length > heardBefore, 10000);
  await until("PPM's card closed", async () => (await kit.card(desk).count()) === 0, 15000);
  await tg.waitFor(chat, "Telegram card closed", (m) => m.message_id === card.message_id && buttonsOf(m).length === 0);
  ctx.record("s23", "desktop", "git_commit from Telegram: the card lists the file before the message with Allow; Allow there commits it, the PPM page hears git:changed and PPM's copy of the card closes");
}

/** 24. Committing 120 staged files: too long to review on Telegram — Deny and Open in PPM only. */
async function s24(ctx, chat) {
  const { fx, tg, paths } = ctx;
  const { alpha } = paths;
  await sessionFor(ctx, chat, "S24");
  const dir = "s24-long-staged";
  mkdirSync(join(alpha, dir), { recursive: true });
  for (let i = 0; i < 120; i++) writeFileSync(join(alpha, dir, `file-number-${String(i).padStart(3, "0")}.txt`), `staged ${i}\n`);
  await git(alpha, "add", "--", dir);
  const before = (await git(alpha, "rev-parse", "HEAD")).trim();
  try {
    await fx.script("s24-commit", [{ mcp: "git_commit", args: { project: "alpha", message: "chore: S24 must not be committed" } }], { match: "S24 commit" });
    await tg.send(chat, "S24 commit 120 file đã stage");
    const card = await tg.waitFor(chat, "long commit card", (m) => m.text.includes("Commit 120 staged files") && buttonsOf(m).length > 0);
    assert.deepEqual(labelsOf(card), ["Deny"], "120 files cannot be reviewed, so not allowed, on Telegram");
    assert.ok(card.text.includes("Too long to review here"));
    assert.match(card.text, /Open in PPM: http/);
    const n = (await tg.answers()).length;
    await tg.pressLabel(chat, card, "Deny");
    assert.equal((await tg.answerAfter(n)).text, "Denied.");
    const [rec] = await done(ctx, "s24-commit");
    assert.equal(rec.isError, true, "declined");
    assert.equal((await git(alpha, "rev-parse", "HEAD")).trim(), before, "nothing was committed");
  } finally {
    await git(alpha, "rm", "-r", "-q", "--cached", "--", dir);
    rmSync(join(alpha, dir), { recursive: true, force: true });
  }
  ctx.record("s24", "telegram", "a commit of 120 staged files is 'Too long to review here' on Telegram with only Deny and Open in PPM; Deny commits nothing");
}

/** 25. A schedule in bypass from Telegram: the warning is on the card; Allow creates it. */
async function s25(ctx, chat) {
  const { fx, tg } = ctx;
  const name = "S25 weekday hello";
  await fx.script("s25-save", [{ mcp: "schedule_save", args: { name, cron: "0 9 * * 1-5", project: "alpha", prompt: "Say hello to the team." } }], { match: "S25 tạo lịch" });
  await tg.send(chat, "S25 tạo lịch 9 giờ các ngày thường nói hello");
  const card = await tg.waitFor(chat, "schedule card", (m) => m.text.includes(name) && buttonsOf(m).length > 0);
  assert.ok(card.text.includes("Every run executes every tool without asking, with nobody watching."), "the bypass warning is on the Telegram card");
  assert.ok(card.text.includes("Say hello to the team."), "the prompt in full");
  assert.deepEqual(labelsOf(card), ["Allow", "Deny"]);
  const n = (await tg.answers()).length;
  await tg.pressLabel(chat, card, "Allow");
  assert.equal((await tg.answerAfter(n)).text, "Allowed.");
  const [rec] = await done(ctx, "s25-save");
  assert.equal(rec.isError, false, rec.text);
  const id = JSON.parse(rec.text).schedule.id;
  try {
    const listed = (await fx.api("/api/schedules")).data.find((s) => s.id === id);
    assert.ok(listed, "the schedule is in /api/schedules");
    assert.equal(listed.name, name);
    assert.equal(listed.permission_mode, "bypassPermissions");
  } finally {
    await fx.call(`/api/schedules/${id}`, { method: "DELETE" });
  }
  ctx.record("s25", "telegram", "schedule_save with no mode from Telegram: the bypass warning and the prompt are on the card; Allow creates it in bypass");
}

/** 26. Switching the public link off from Telegram: the card says Open in PPM stops working; Deny. */
async function s26(ctx, chat) {
  const { fx, tg } = ctx;
  const enabledNow = async () => (await fx.api("/__assistant-test/tunnel-config")).tunnel?.enabled !== false;
  assert.equal(await enabledNow(), true, "the public link starts on");
  await fx.script("s26-off", [{ mcp: "public_link_set", args: { enabled: false } }], { match: "S26 tắt link" });
  await tg.send(chat, "S26 tắt link công khai");
  const card = await tg.waitFor(chat, "public link card", (m) => /Switch off PPM.s public address/.test(m.text) && buttonsOf(m).length > 0);
  assert.ok(card.text.includes("Open in PPM buttons stop working"), "the card says Telegram's Open in PPM stops working");
  const n = (await tg.answers()).length;
  await tg.pressLabel(chat, card, "Deny");
  assert.equal((await tg.answerAfter(n)).text, "Denied.");
  const [rec] = await done(ctx, "s26-off");
  assert.equal(rec.isError, true, "declined");
  assert.equal(await enabledNow(), true, "still on");
  ctx.record("s26", "telegram", "public_link_set off from Telegram: the card says Open in PPM stops working; Deny leaves the link on");
}

/** 27. tunnels_status with a named tunnel configured: its token appears nowhere. */
async function s27(ctx, chat) {
  const { fx, tg } = ctx;
  const original = (await fx.api("/__assistant-test/tunnel-config")).tunnel;
  const token = `eyJFAKE${crypto.randomUUID().replace(/-/g, "")}TOKEN`;
  const from = (await tg.calls()).total;
  await fx.post("/__assistant-test/tunnel-config", {
    ...(original ?? {}), mode: "named", namedTunnelToken: token, namedTunnelHostname: "ppm-e2e.example.com",
    namedTunnelName: "ppm-e2e", zoneID: "zone-e2e", accountID: "account-e2e",
  });
  try {
    await fx.script("s27-status", [{ mcp: "tunnels_status" }], { match: "S27 trạng thái tunnel" });
    await tg.send(chat, "S27 trạng thái tunnel");
    const [rec] = await done(ctx, "s27-status");
    assert.equal(rec.isError, false, rec.text);
    const status = JSON.parse(rec.text);
    assert.equal(status.publicLink.mode, "named");
    assert.equal(status.publicLink.hostname, "ppm-e2e.example.com");
    for (const leaked of [token, token.slice(0, 6), "tokenMasked", "certState"]) assert.ok(!rec.text.includes(leaked), `the tool's answer holds no ${leaked.slice(0, 12)}`);
    await tg.waitText(chat, 'Turn "s27-status" done.');
    const { calls } = await tg.calls(from);
    assert.ok(calls.length > 0, "the turn reached Telegram");
    assert.ok(!calls.some((c) => (c.raw ?? "").includes(token) || (c.raw ?? "").includes(`${token.slice(0, 6)}...`)), "no Bot API body carries the token or its masked form");
  } finally {
    await fx.post("/__assistant-test/tunnel-config", original ?? {});
  }
  ctx.record("s27", "telegram", "tunnels_status with a named tunnel configured: mode and hostname, never the token or its masked form, in the tool's answer or any Bot API body");
}

export function plan(ctx, state, { desk }) {
  const { CHATS } = ctx;
  return [
    ["s23", "desktop", [CHATS.ops], () => s23(ctx, CHATS.ops, desk)],
    ["s24", "telegram", [CHATS.opsLong], () => s24(ctx, CHATS.opsLong)],
    ["s25", "telegram", [CHATS.ops], () => s25(ctx, CHATS.ops)],
    ["s26", "telegram", [CHATS.ops], () => s26(ctx, CHATS.ops)],
    ["s27", "telegram", [CHATS.ops], () => s27(ctx, CHATS.ops)],
  ];
}
