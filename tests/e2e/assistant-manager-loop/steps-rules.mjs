// Step 7 of the manager loop: the manager edits its own rules file. A removed line is put back and
// held for the user; approved, it reaches the next turn with no stream restart. An "Exception:"
// line is held; a plain restriction is accepted under "added since" and quoted on a note.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { until } from "./loop-kit.mjs";

const APPROVED = "## Approved rules (authoritative)";
const ADDED_SINCE = "## Rules the manager added since";
const REMOVED_LINE = "- Keep plans and state in project files; this chat compacts.";
const EXCEPTION_LINE = "- Exception: a Friday deploy needs no OK.";
const RESTRICTION_LINE = "- Run the full test suite before any merge.";

const rulesFile = (s) => join(s.alpha, ".ppm", "manager.md");
const readRules = (s) => readFileSync(rulesFile(s), "utf8");
const lines = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);

/** One manager turn that writes the rules file, then the next turn, at whose start PPM checks it. */
async function editThenNextTurn(k, s, label, text) {
  await k.managerTurn("alpha", s.aChat, `${label}-write`, [{ writeFile: { path: ".ppm/manager.md", text } }], `${label}: edit your rules`);
  await k.idle(s.aChat);
  const next = await k.managerTurn("alpha", s.aChat, `${label}-next`, [], `${label}: carry on`);
  await k.idle(s.aChat);
  return next;
}

/** A held change's card in the stream, answered with one of its buttons. */
async function decideInPpm(k, title, button) {
  const card = k.body().locator('[data-assistant-card="rules_change"][data-card-status="open"]').last();
  await card.waitFor({ timeout: 20000 });
  if (title) assert.match(await card.innerText(), title);
  await card.getByRole("button", { name: button }).click();
}

export async function step7(k, s) {
  const original = readRules(s);
  assert.ok(original.includes(REMOVED_LINE), "the template line is there to remove");
  const shorter = original.split("\n").filter((l) => l.trim() !== REMOVED_LINE).join("\n");

  // A removed line: the file goes back, and the change waits for the user.
  const held = await editThenNextTurn(k, s, "s7-remove", shorter);
  await until("the file restored", () => readRules(s) === original);
  const change = await k.cardOf("rules_change");
  assert.equal(change.body, "The manager removed or changed lines.");
  assert.ok((await k.rules("alpha")).rules.proposedDiff.removed.some((l) => l.includes("Keep plans and state")), "the held change is the removed line");
  await k.shot("09-rules-change-waiting");
  await decideInPpm(k, /changed its rules/, "Approve change");
  await until("approved", async () => !lines((await k.rules("alpha")).rules.approved ?? "").includes(REMOVED_LINE) && (await k.rules("alpha")).rules.proposed === null);
  const after = await k.managerTurn("alpha", s.aChat, "s7-after-approve", [], "s7: next step please");
  await k.idle(s.aChat);
  assert.ok(after.sharedContext?.includes(APPROVED), "the turn carries the approved block");
  assert.ok(!after.sharedContext.includes(REMOVED_LINE), "without the removed line");
  assert.equal(after.runId, held.runId, "the same stream: no provider restart");

  // "Exception:" is held, then reverted.
  const approvedText = readRules(s);
  await editThenNextTurn(k, s, "s7-exception", `${approvedText.trimEnd()}\n${EXCEPTION_LINE}\n`);
  await until("exception put back", () => !readRules(s).includes(EXCEPTION_LINE));
  await until("exception held", async () => (await k.rules("alpha")).rules.proposed?.includes(EXCEPTION_LINE));
  await decideInPpm(k, null, "Revert");
  await until("reverted", async () => (await k.rules("alpha")).rules.proposed === null);
  const checks = await k.fx.api("/__assistant-test/rules-checks");
  assert.ok(!checks.flat().some((l) => l.includes("Friday deploy")), "a keyword line is held without asking the model");

  // A plain restriction: accepted, quoted on a note, and in the block of lines added since.
  const restricted = await editThenNextTurn(k, s, "s7-restrict", `${readRules(s).trimEnd()}\n${RESTRICTION_LINE}\n`);
  assert.ok(readRules(s).includes(RESTRICTION_LINE), "the line stays in the file");
  const restriction = RESTRICTION_LINE.slice(2);
  const note = await until("the rules note", async () => (await k.cards()).find((c) => c.kind === "rules_note" && (c.payload.added ?? []).some((l) => l.includes(restriction))));
  assert.match(note.title, /^The manager added 1 rule line$/);
  assert.ok((await k.fx.api("/__assistant-test/rules-checks")).flat().some((l) => l.includes(restriction)), "the check was asked about it");
  const ctx = restricted.sharedContext ?? "";
  assert.ok(ctx.includes(ADDED_SINCE) && ctx.indexOf(RESTRICTION_LINE) > ctx.indexOf(ADDED_SINCE), "listed under added since");
  assert.equal(restricted.runId, held.runId, "still no restart");
  await k.body().locator('[data-assistant-card="rules_note"]').last().waitFor({ timeout: 15000 });
  await k.shot("10-rules-note");
  k.record("7", "a removed rule line is restored and held; Approve reaches the next turn without a restart; Exception: is held; a plain restriction is accepted under added since and quoted on a note");
}
