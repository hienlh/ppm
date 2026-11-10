// Steps 10–11 of the manager loop: the morning digest with one manager busy, and the notebook — a
// line the Assistant writes in a wake turn is Unverified and the user deletes it in Settings; the
// Assistant cannot delete the user's own line.
import assert from "node:assert/strict";
import { hhmm, until } from "./loop-kit.mjs";

const ASK = "Morning digest. When you are free";
const NOTE = "Beta's migration finished overnight (from the digest).";
const USER_NOTE = "Releases go out on Tuesdays only.";

/** 10. Digest time: B is busy and answers after its turn, A at once; one digest card. */
export async function step10(k, s) {
  const digest = (project, items) => ({ session: "report_to_assistant", args: { kind: "digest", title: `${project} digest`, items } });
  await k.script("s10-alpha-digest", [digest("alpha", ["Alpha: nothing waits on you"])], { match: ASK, sessionId: s.aChat });
  await k.script("s10-beta-digest", [digest("beta", ["Beta: migration finished"])], { match: ASK, sessionId: s.bChat });
  // The digest card wakes the main session once; that turn writes a note.
  await k.script("s11-note", [{ mcp: "notebook_add", args: { text: NOTE } }], { match: "morning digest of the manager chats", reply: "[no reply]" });
  const now = await k.now();
  await k.patchSettings({ timezone: "UTC", digest: { enabled: true, time: hhmm(now + 2 * 60_000) } });
  const busy = await k.managerTurn("beta", s.bChat, "s10-busy", [{ sleep: 6000 }], "Run the long migration", "default");
  await k.advance(3 * 60_000);
  const card = await k.cardOf("digest", null, 60000);
  const a = await k.fx.turnOf("s10-alpha-digest");
  const b = await k.fx.turnOf("s10-beta-digest");
  assert.ok(a && b, "both managers were asked");
  assert.ok(a.at < b.at, "A answered at once, B after its running turn");
  assert.ok(b.at >= busy.at + 5000, "B's ask waited for the long turn to end");
  assert.equal(a.blocks.provenance?.startedBy, "ppm");
  const projects = Object.fromEntries(card.payload.projects.map((p) => [p.name, p.items]));
  assert.deepEqual(projects, { alpha: ["Alpha: nothing waits on you"], beta: ["Beta: migration finished"] });
  assert.equal((await k.cards()).filter((c) => c.kind === "digest").length, 1, "one digest card");
  await k.tg.waitText(k.owner, "Morning digest");
  await k.body().locator("[data-digest-fold]").last().waitFor({ timeout: 20000 });
  await k.shot("13-digest-card");
  k.record("10", "digest: A answers at once, busy B after its turn; one digest card in PPM and on Telegram");
}

/** 11. The wake turn's note is Unverified in Settings and the user deletes it; the Assistant cannot delete the user's line. */
export async function step11(k, s) {
  // Every unattended turn counts against the hourly wake cap; if the late replies of step 8 used it
  // up, the digest's news waits for the next hour, which the clock can bring.
  let added;
  for (let hour = 0; !added && hour < 3; hour++) {
    added = await k.answered("s11-note", 1, 20000).then(([c]) => c, () => null);
    if (!added) await k.advance(61 * 60_000);
  }
  assert.ok(added, "the digest woke the Assistant");
  assert.equal(added.isError, false, added.text);
  const note = await until("the Assistant's note", async () => (await k.notes()).find((n) => n.text === NOTE));
  assert.equal(note.source, "assistant");
  assert.equal(note.unverified, true, "written in a turn nobody started");
  await k.idle(s.main);

  // The gear sits in the Assistant window's titlebar, outside its body.
  await k.page.locator('[aria-roledescription="window"][aria-label="Assistant"] button[aria-label="PPM Assistant settings"]').first().click();
  const settings = k.page.locator('[aria-roledescription="window"][aria-label="Settings"]');
  await settings.waitFor({ timeout: 15000 });
  await settings.locator("[data-testid=assistant-settings-tab-notebook]").first().click();
  const row = settings.locator(`li[data-note-id="${note.id}"]`);
  await row.waitFor({ timeout: 15000 });
  assert.equal(await row.locator("[data-unverified]").innerText(), "Unverified");
  await k.shot("14-notebook-unverified");
  await row.getByRole("button", { name: "Delete note" }).click();
  await until("note deleted", async () => !(await k.notes()).some((n) => n.id === note.id));

  const panel = settings.locator("[role=tabpanel][data-panel=notebook]").first();
  await panel.getByRole("button", { name: "Add line" }).click();
  await panel.locator('textarea[aria-label="New note"]').fill(USER_NOTE);
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  const mine = await until("the user's note", async () => (await k.notes()).find((n) => n.text === USER_NOTE));
  assert.equal(mine.source, "user");
  await settings.locator('button[aria-label="Close window"]').first().click();

  await k.askAssistant("s11-delete", [{ mcp: "notebook_delete", args: { id: mine.id } }], "Tidy up the notebook");
  const [refused] = await k.answered("s11-delete", 1);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /The user wrote this line/);
  assert.ok((await k.notes()).some((n) => n.id === mine.id), "the user's line is still there");
  await k.shot("15-notebook-delete-refused");
  k.record("11", "a note written in a wake turn shows Unverified and the user deletes it in Settings; the Assistant's delete of the user's line is refused");
}
