// Steps 1–2 of the manager loop: a manager assigned from the chat menu, one created by the
// Assistant behind a single card, and the Assistant asking a manager without any card.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { gitStatus, until } from "./loop-kit.mjs";

const MANAGER_CONSEQUENCE = "After this, PPM Assistant can message this chat without asking, also while you are away.";

/** `.ppm/manager.md` and its `.gitignore` written, and git seeing nothing new in the project. */
function assertRulesFilesIgnored(dir) {
  assert.ok(existsSync(join(dir, ".ppm", "manager.md")), `${dir}: the rules file was written`);
  const ignore = readFileSync(join(dir, ".ppm", ".gitignore"), "utf8");
  assert.match(ignore, /^\/manager\.md$/m, ".ppm/.gitignore lists the rules file");
  assert.doesNotMatch(ignore, /^\*$/m, "never `*`: .ppm/ is also a skill root");
  assert.equal(gitStatus(dir), "", `${dir}: git sees nothing new`);
}

/** 1. A's manager from the session row's menu; B's created by the Assistant behind one card. */
export async function step1(k, s) {
  const { page, web, fx } = k;
  await page.goto(`${web}/project/alpha`);
  const row = page.getByText(s.aTitle, { exact: true }).first();
  await row.waitFor({ timeout: 30000 });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Set as manager chat" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText(MANAGER_CONSEQUENCE).first().waitFor({ timeout: 15000 });
  await k.shot("01-assign-dialog");
  await dialog.getByRole("button", { name: "Set as manager chat" }).click();
  await until("alpha has its manager", async () => (await k.managers()).some((m) => m.projectName === "alpha" && m.sessionId === s.aChat));
  await page.getByText("Manager", { exact: true }).first().waitFor({ timeout: 15000 });
  assertRulesFilesIgnored(s.alpha);

  await page.goto(`${web}/project/alpha/assistant`);
  await k.composer().waitFor({ timeout: 30000 });
  await k.askAssistant("s1-create-beta", [{ session: "create_session", args: { project: "beta", manager: true } }], "Set up a manager chat for beta");
  assert.equal((await fx.turnOf("s1-create-beta")).sessionId, s.main, "the Assistant window talks to the main session");
  const card = k.body().locator("[data-collab-approval]");
  await card.first().waitFor({ timeout: 30000 });
  assert.equal(await card.count(), 1, "one card");
  const text = await card.first().innerText();
  assert.match(text, /Create the manager chat for beta/);
  assert.ok(text.includes(MANAGER_CONSEQUENCE), "the card states what the role allows");
  await k.tg.waitText(k.owner, 'Create the manager chat for "beta"');
  await k.shot("02-create-manager-card");
  await card.first().getByRole("button", { name: "Allow once" }).click();
  const [created] = await k.answered("s1-create-beta", 1);
  assert.equal(created.isError, false, created.text);
  const result = k.parse(created);
  assert.equal(result.manager, true);
  assert.equal(result.project, "beta");
  s.bChat = result.sessionId;
  await until("beta has its manager", async () => (await k.managers()).some((m) => m.projectName === "beta" && m.sessionId === s.bChat));
  assertRulesFilesIgnored(s.beta);
  await k.body().locator('[data-manager-chip="beta"]').waitFor({ timeout: 15000 });
  await k.shot("03-two-managers");
  k.record("1", "A's manager set from the chat menu; B's created by the Assistant behind one card; .ppm/ ignored by git in both");
}

/** 2. The user asks the Assistant about A: the message goes `next`, carries no card, and the reply comes back. */
export async function step2(k, s) {
  const question = "How is alpha doing?";
  await k.script("s2-alpha-answers", [], { match: question, sessionId: s.aChat, reply: "Alpha: two tickets left, nothing waits on you." });
  await k.askAssistant("s2-ask-alpha", [{ session: "send_to_session", args: { session_id: s.aChat, message: question, wait: true } }], "How is alpha today?");
  const [sent] = await k.answered("s2-ask-alpha", 1, 60000);
  assert.equal(sent.isError, false, sent.text);
  assert.match(sent.text, /two tickets left/, "the manager's reply came back in the tool's answer");
  assert.equal(await k.body().locator("[data-collab-approval]").count(), 0, "no card was shown");
  const got = await k.fx.turnOf("s2-alpha-answers");
  assert.equal(got.blocks.content, question, "the manager got the Assistant's words");
  assert.equal(got.blocks.fromSession?.kind, "assistant");
  assert.equal(got.blocks.provenance?.startedBy, "user_ppm", "the provenance says the user started the turn in PPM");
  assert.equal(got.blocks.provenance?.untrusted, false);
  assert.notEqual(got.priority, "later", `the message was not held for the manager's turn end (${got.priority ?? "a new turn"})`);
  assert.ok((got.sharedContext ?? "").includes("## Approved rules (authoritative)"), "the manager's turn carries its rules");
  await k.shot("04-asked-alpha");
  k.record("2", "Assistant → A's manager without a card: provenance user_ppm, untrusted false, next; the reply arrives", { priority: got.priority ?? "new turn" });
}
