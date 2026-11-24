// Step 12 of the manager loop: a chat the manager opened waits on an approval, and the user finds it
// in the Assistant's "Waiting on you" with its buttons, at desktop and phone width; the manager's
// report about the same card is folded into it, and Allow there lets the chat go on.
import assert from "node:assert/strict";
import { until } from "./loop-kit.mjs";

const COMMAND = "npm run release:alpha";

/** 12. A manager's child chat asks to run a command: its card is in Waiting on you, answerable there. */
export async function step12(k, s) {
  const child = (await k.fx.post("/api/project/alpha/chat/sessions", { providerId: "claude", title: "Alpha release" })).data.id;
  await k.fx.post("/__assistant-test/spawn-link", { childId: child, parentId: s.aChat });

  await k.managerTurn("alpha", child, "s12-child", [{ builtin: "Bash", input: { command: COMMAND } }], "Release alpha", "default");
  const card = await until("the child's card", async () =>
    (await k.cards()).find((c) => c.kind === "approval" && c.sessionId === child && c.status === "open"), 30000);
  assert.equal(card.payload.deciding?.text, COMMAND);
  assert.equal(card.payload.chat?.title, "Alpha release", "the card names the chat it waits in");

  // The manager reports the same card: folded into the child's, nothing new filed.
  const before = (await k.cards()).length;
  await k.managerTurn("alpha", s.aChat, "s12-report", [{
    session: "report_to_assistant",
    args: { kind: "needs_decision", title: "Alpha release waits for your OK", body: "The release chat wants to run the release.", chat: child },
  }], "Check on the alpha release");
  const [report] = await k.answered("s12-report", 1);
  assert.equal(report.isError, false, report.text);
  const folded = k.parse(report);
  assert.equal(folded.cardId, card.id, "the report came back with the child's card");
  assert.equal(folded.kind, "approval");
  assert.equal((await k.cards()).length, before, "no second card was filed");
  await k.idle(s.aChat);

  const inPpm = k.streamCard("approval", COMMAND);
  await inPpm.waitFor({ timeout: 20000 });
  // Counted on the Waiting chip with the rest, and drawn whole in the stream with its buttons.
  const chip = k.body().locator("[data-waiting-dock]").first();
  await chip.waitFor({ timeout: 15000 });
  assert.ok(Number(await chip.getAttribute("data-waiting-count")) >= 1, "the chip counts the child's card");
  await inPpm.scrollIntoViewIfNeeded();
  await inPpm.getByRole("button", { name: "Allow", exact: true }).waitFor({ timeout: 10000 });
  await k.shot("16-child-card-waiting-1440");

  await k.page.setViewportSize({ width: 390, height: 844 });
  await k.page.waitForTimeout(600);
  const onPhone = k.page.locator(`[data-assistant-card="approval"]:visible`, { hasText: COMMAND }).last();
  await onPhone.waitFor({ timeout: 20000 });
  await onPhone.scrollIntoViewIfNeeded();
  await k.shot("17-child-card-waiting-390");
  await onPhone.getByRole("button", { name: "Allow", exact: true }).click();
  await k.page.setViewportSize({ width: 1440, height: 900 });

  const [ran] = await k.answered("s12-child", 1);
  assert.equal(ran.approved, true, "Allow on the mirror let the child run the command");
  await until("child card answered", async () => (await k.cards()).find((c) => c.id === card.id)?.status === "answered");
  await k.idle(child);
  k.record("12", "a manager's child chat's approval is in Waiting on you with its buttons (1440 and 390); the manager's report about it folds into it; Allow there runs it");
}
