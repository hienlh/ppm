// Turn-reference e2e, part 3: another project's turn (6) and what its chip grants the AI (7, second
// half; 10, the range read), the tools switch (9), a queued message's own turn id (12), and editing
// a message that carries chips (13).
import assert from "node:assert/strict";
import { COMPOSER, PIN_PX } from "./session-turn-refs-helpers.mjs";
import { send, turnLink } from "./session-turn-refs-steps-links.mjs";
import { clickBubbleChip } from "./session-turn-refs-steps-window.mjs";

const TOOLS_OFF = "The AI can't read this turn — turn read_session_turns back on in Settings → Tools";

async function answered(kit, from, n) {
  return kit.until(`${n} tool calls answered`, async () => {
    const mine = await kit.callsSince(from);
    return mine.length === n && mine.every((c) => c.text !== undefined) ? mine : null;
  }, 30000);
}

export async function runCrossSteps(ctx) {
  const { page, kit, web, ids } = ctx;
  const { A, B, D } = ids;
  await ctx.resetLayout(page);

  // ── 6: a turn of another project, and what sending it grants (7, second half; 10, ranges) ──
  await kit.scenario("6", async () => {
    const area = await kit.chatArea(page, "alpha", B.id);
    const box = area.locator(`${COMPOSER}:visible`).first();
    await kit.paste(box, turnLink(web, "beta", "claude", D.id, D.turnIds[1]));
    const [chip] = await kit.readyChips(area, 1);
    assert.match(chip, /Billing export/);
    assert.match(chip, /Turn 2\b/);
    assert.match(chip, /· beta/);
    await kit.shot(page, "06-other-project-chip");
    const from = (await kit.api("/__turn-test/calls")).calls.length;
    await kit.plan(B.id, { ops: [
      { tool: "read_session_turns", args: { session_id: D.id, turn_ids: [D.turnIds[1]], project: "beta" } },
      { tool: "read_session_turns", args: { session_id: D.id, turn_ids: [D.turnIds[2]], project: "beta" } },
      { tool: "read_session_turns", args: { session_id: D.id, from_turn: 1, to_turn: 3, project: "beta" } },
    ] });
    await send(area, "and this billing turn");
    const [granted, other, range] = await answered(kit, from, 3);
    assert.equal(granted.isError, false, granted.text);
    assert.match(granted.text, /User: Billing export, question 2/);
    // Another project's turn is named as such, so the AI does not take beta for its own project.
    assert.match(granted.text, new RegExp(`Session ${D.id} · claude · project beta, not this chat's project · Turn 2`));
    assert.equal(other.isError, true, "a turn of that session whose link was not sent stays refused");
    assert.match(other.text, /not_permitted/);
    assert.equal(range.isError, true, "a range of another project is refused even after a chip");
    assert.match(range.text, /not_permitted/);
    kit.record("7/10: after the chip is sent the AI reads exactly that turn of beta; another turn and a range stay refused", {
      granted: granted.text.split("\n")[0], other: other.text.slice(0, 160), range: range.text.slice(0, 160),
    });

    await clickBubbleChip(ctx, "alpha", B.id, "Billing export");
    await kit.until("switched to beta", async () => page.url().includes("/project/beta"), 20000);
    // D is short: its whole history fits, so the turn is pinned only as far as the list can scroll.
    const at = await kit.until("D's turn 2 on screen", async () => {
      const o = await kit.offsetOf(page, D.turnIds[1]);
      return o && (Math.abs(o.offset - PIN_PX) <= 2 || (!o.canScroll && o.offset >= 0 && o.offset < o.height)) ? o : null;
    }, 20000, 50);
    await kit.shot(page, "06-switched-to-beta");
    kit.record("6: the chip names project beta, and clicking it switches project and pins D's turn 2", { offset: at.offset, url: page.url() });
    await ctx.resetLayout(page);
  });

  // ── 9: read_session_turns off in Settings → Tools: the chip warns, the message still sends ──
  await kit.scenario("9", async () => {
    await ctx.resetLayout(page);
    await page.keyboard.press("Control+,");
    await page.getByRole("button", { name: "Tools", exact: true }).first().click();
    const toggle = page.getByRole("switch", { name: /read_session_turns/ });
    await toggle.waitFor({ timeout: 15000 });
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await toggle.click();
    await kit.until("saved off", async () => (await kit.api("/api/settings/ai")).data?.ppm_tools?.read_session_turns === false, 10000);
    await kit.shot(page, "09-settings-tools-off");
    await page.getByRole("button", { name: "Close window" }).first().click();
    await kit.until("settings closed", async () => (await page.getByRole("switch", { name: /read_session_turns/ }).count()) === 0, 5000);
    const area = await kit.chatArea(page, "alpha", B.id);
    const box = area.locator(`${COMPOSER}:visible`).first();
    await kit.paste(box, turnLink(web, "alpha", "claude", A.id, A.turnIds[324]));
    await kit.readyChips(area, 1);
    await area.locator(`[data-composer-turn-refs] [aria-label="${TOOLS_OFF}"]`).waitFor({ timeout: 15000 });
    await kit.shot(page, "09-chip-warning");
    await kit.plan(B.id, { text: "Sent with the tools off." });
    await send(area, "tools are off, send anyway");
    const sent = area.locator("[data-turn-refs]").last();
    await sent.locator('[data-turn-chip="ready"]', { hasText: "Turn 325" }).waitFor({ timeout: 15000 });
    await area.locator("text=tools are off, send anyway").first().waitFor();
    await area.locator("text=Sent with the tools off.").first().waitFor({ timeout: 15000 });
    await kit.api("/api/settings/ai", { method: "PUT", body: JSON.stringify({ ppm_tools: { read_session_turns: true } }) });
    kit.record("9: with read_session_turns switched off in Settings → Tools the composer chip warns and the message still sends");
  });

  // ── 12: a message queued mid-turn copies its own turn's id, not the running one ──
  await kit.scenario("12", async () => {
    await ctx.resetLayout(page);
    const area = await kit.chatArea(page, "alpha", B.id);
    await kit.plan(B.id, { streamMs: 10000, text: "Working through the first request slowly, one word at a time, until it is done." }, { text: "Second request handled." });
    await send(area, "first, slow request");
    await area.locator("text=Working through").first().waitFor({ timeout: 15000 });
    await send(area, "second, queued request");
    const row = area.locator("[data-msg-id]", { hasText: "second, queued request" }).last();
    await row.waitFor({ timeout: 10000 });
    // The list follows the stream, so the row never holds still: a plain DOM click, at once.
    const copiedBefore = (await kit.copied(page)).length;
    await row.getByRole("button", { name: "Copy turn link" }).dispatchEvent("click");
    await row.getByRole("button", { name: "Getting link…" }).waitFor({ timeout: 3000 });
    assert.equal((await kit.copied(page)).length, copiedBefore, "nothing is copied while the turn has no id");
    await kit.shot(page, "12-queued-waiting");
    await row.getByRole("button", { name: "Link ready" }).waitFor({ timeout: 30000 });
    const before = (await kit.copied(page)).length;
    await row.getByRole("button", { name: "Link ready" }).dispatchEvent("click");
    const link = await kit.until("queued link copied", async () => (await kit.copied(page))[before], 10000);
    const turns = (await kit.api(`/api/project/alpha/chat/sessions/${B.id}/turns?providerId=claude`)).data.turns;
    const [running, queued] = turns.slice(-2);
    assert.equal(queued.prompt, "second, queued request");
    assert.equal(running.prompt, "first, slow request");
    assert.equal(link, turnLink(web, "alpha", "claude", B.id, queued.turnId), "the link names the queued message's own turn");
    kit.record("12: Copy turn link on a queued message waits, says Link ready once its turn starts, and copies its own turn id", { running: running.turnId, queued: queued.turnId });
  });

  // ── 13: edit a message with chips: chips come back, not JSON; the re-send keeps the grants ──
  await kit.scenario("13", async () => {
    const area = await kit.chatArea(page, "alpha", B.id);
    await kit.until("idle", async () => (await area.locator("text=Second request handled.").count()) > 0, 20000);
    const row = area.locator("[data-msg-id]", { hasText: "Compare these two turns" }).first();
    await row.scrollIntoViewIfNeeded();
    await row.hover();
    await row.getByRole("button", { name: "Edit" }).click();
    const chips = await kit.readyChips(area, 2);
    const box = area.locator(`${COMPOSER}:visible`).first();
    const text = await box.inputValue();
    assert.equal(text, "Compare these two turns");
    assert(!/ppm-turnrefs|"turnId"/.test(text), "no block text in the composer");
    await kit.shot(page, "13-edit-shows-chips");
    await box.fill("Compare these two turns again");
    await box.press("Enter");
    const forked = await kit.until("the tab moved to the edited version", async () => {
      const panel = Object.values((await kit.layoutOf(page, "alpha")).panels).find((p) => p.tabs.some((t) => t.id === `chat:claude/${B.id}`));
      const id = panel?.tabs.find((t) => t.id === `chat:claude/${B.id}`)?.metadata?.sessionId;
      return id && id !== B.id ? id : null;
    }, 20000);
    await kit.until("edited message sent", async () => (await area.locator("[data-turn-refs]", { hasText: "Turn 290" }).count()) > 0, 20000);
    const grants = await kit.until("grants on the edited version", async () => {
      const g = (await kit.api(`/__turn-test/grants?sessionId=${forked}`)).grants;
      return g.length >= 2 ? g : null;
    }, 15000);
    assert.deepEqual(grants.map((g) => g.turnId).sort(), [A.turnIds[39], A.turnIds[289]].sort());
    kit.record("13: Edit puts the chips back in the composer (no block text) and the re-send grants them to the edited version", { forked, chips });
    ctx.editedB = forked;
    await ctx.resetLayout(page);
  });
}
