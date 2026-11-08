// Turn-reference e2e, part 1: the AI's three tools from a chat of the same project (scenario 7,
// before any grant), Copy turn link in the history window and the live list, pasting links into
// another chat as chips (1), and a sent chip that renders after a reload with no request (2).
import assert from "node:assert/strict";
import { COMPOSER } from "./session-turn-refs-helpers.mjs";

export const RAW_OUTPUT = "RAW-TOOL-OUTPUT token=sk-fixture-secret";
export const turnLink = (web, project, provider, session, turnId) => `${web}/project/${project}/chat/${provider}/${session}?turn=${encodeURIComponent(turnId)}`;

/** Type into the chat's own composer and send. */
export async function send(area, text) {
  const box = area.locator(`${COMPOSER}:visible`).first();
  await box.fill(text);
  await box.press("Enter");
}

/** Copy turn link on the row starting `turnId` (window or live list); resolves with the new link. */
export async function copyLinkOf(ctx, turnId, { inWindow = false } = {}) {
  const { page, kit } = ctx;
  const before = (await kit.copied(page)).length;
  const scope = inWindow ? "[data-history-window] " : "";
  const row = page.locator(`${scope}[data-turn-start="${turnId}"]:visible`).first();
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByRole("button", { name: /Copy turn link|Link ready/ }).click();
  return kit.until(`link for ${turnId} copied`, async () => (await kit.copied(page))[before], 15000);
}

export async function runLinkSteps(ctx) {
  const { page, kit, web, ids } = ctx;
  const { A, B, C, D } = ids;
  const t = (n) => A.turnIds[n - 1];

  // ── 7 (first half): the AI's tools in this project, before any grant exists ──
  await kit.scenario("7 (first half)", async () => {
    const area = await kit.chatArea(page, "alpha", B.id);
    const from = (await kit.api("/__turn-test/calls")).calls.length;
    await kit.plan(B.id, { ops: [
      { tool: "search_sessions", args: { query: "quasar lattice migration" } },
      { tool: "list_session_turns", args: { session_id: A.id, offset: 325, limit: 5 } },
      { tool: "read_session_turns", args: { session_id: A.id, turn_ids: [t(77)] } },
      { tool: "read_session_turns", args: { session_id: D.id, turn_ids: [D.turnIds[1]], project: "beta" } },
      { tool: "read_session_turns", args: { session_id: C.id, turn_ids: [C.rolledBack] } },
    ] });
    await send(area, "find the lattice plan and check the other chats");
    const [search, list, read, foreign, rolled] = await kit.until("five tool calls answered", async () => {
      const mine = await kit.callsSince(from);
      return mine.length === 5 && mine.every((c) => c.text !== undefined) ? mine : null;
    }, 30000);
    assert.equal(search.isError, false, search.text);
    assert.match(search.text, new RegExp(`${A.id} · claude · Long refactor · Turn 77 · ${t(77)}`));
    // The session line says the turn is in the chat's own project (see `labelFor` in chat-turn-ref.ts).
    assert.match(list.text, new RegExp(`Session ${A.id} · claude · this project \\(alpha\\) · 330 turns · showing turns 1–5`));
    assert.match(list.text, new RegExp(`^1 · ${t(1)} · `, "m"));
    assert.equal(read.isError, false, read.text);
    assert.match(read.text, /User: Q77: plan the quasar lattice migration for the storage layer/);
    assert.match(read.text, /→ Bash /);
    for (const leaked of [RAW_OUTPUT, "sk-fixture-secret", "<mark>"]) assert(!read.text.includes(leaked), `read leaked ${leaked}`);
    assert.equal(foreign.isError, true, "another project's turn is refused before any link was sent");
    assert.match(foreign.text, /not_permitted/);
    assert.match(rolled.text, new RegExp(`Turn ${C.rolledBack}: rolled_back`));
    await area.locator("text=/Answer \\d+: noted\\./").first().waitFor({ timeout: 15000 });
    await kit.shot(page, "07-ai-tools-own-project");
    kit.record("7: search_sessions finds the seeded phrase with its turn id, list numbers from 1, read has no raw tool output, another project is refused, a rolled-back Codex turn says rolled_back", {
      search: search.text.split("\n").slice(0, 3), list: list.text.split("\n").slice(0, 3),
    });
  });

  // ── Copy turn link: in the history window (a turn link opened directly) and in the live list ──
  const links = {};
  for (const n of [40, 290]) {
    await page.goto(turnLink(web, "alpha", "claude", A.id, t(n)));
    await kit.until(`turn ${n} in the window`, async () => (await kit.offsetOf(page, t(n)))?.inWindow, 30000);
    assert(!page.url().includes("turn="), "?turn= is taken off the address once the jump is asked for");
    links[n] = await copyLinkOf(ctx, t(n), { inWindow: true });
    assert.equal(links[n], turnLink(web, "alpha", "claude", A.id, t(n)));
  }
  await page.getByRole("button", { name: /Back to latest/ }).first().click();
  await kit.until("live list back", async () => (await page.locator("[data-history-window]").count()) === 0, 10000);
  const live = await copyLinkOf(ctx, t(325));
  assert.equal(live, turnLink(web, "alpha", "claude", A.id, t(325)));
  ctx.links = links;
  kit.record("Copy turn link writes the turn's URL from the history window (turns 40, 290) and from the live list (turn 325)", { links });

  // ── 1: paste into another chat → chips ──
  await kit.scenario("1", async () => {
    const area = await kit.chatArea(page, "alpha", B.id);
    const box = area.locator(`${COMPOSER}:visible`).first();
    const metaRequests = [];
    const onRequest = (r) => { if (/\/turns\/[^/?]+\?providerId=/.test(r.url())) metaRequests.push(r.url()); };
    page.on("request", onRequest);
    await kit.paste(box, `${links[40]}\n${links[290]}`);
    const chips = await kit.readyChips(area, 2);
    page.off("request", onRequest);
    assert.equal(await box.inputValue(), "", "a paste that is only links inserts no text");
    for (const [text, n] of [[chips[0], 40], [chips[1], 290]]) {
      assert.match(text, /Long refactor/);
      assert.match(text, new RegExp(`Turn ${n}\\b`));
      assert(!/· alpha/.test(text), "no project name for this project's own turn");
    }
    assert.equal(await area.locator('[data-composer-turn-refs] [data-turn-chip="ready"] span[title="claude"]').count(), 2, "each chip shows the provider icon");
    assert.equal(metaRequests.length, 2, "each chip resolved its turn once");
    await kit.shot(page, "01-composer-chips");
    kit.record("1: two pasted links become chips with the session title, Turn N and the provider icon", { chips });

    // ── 2: send, then reload: the chip renders from the message, with no request ──
    await send(area, "Compare these two turns");
    const bubble = area.locator("[data-turn-refs]").last();
    await bubble.locator('[data-turn-chip="ready"]').nth(1).waitFor({ timeout: 15000 });
    await area.locator("text=/Answer \\d+: noted\\./").nth(1).waitFor({ timeout: 15000 });
    const urls = [];
    page.on("request", (r) => urls.push(r.url()));
    await page.reload();
    const after = await kit.chatArea(page, "alpha", B.id);
    const sent = after.locator("[data-turn-refs]").last();
    await sent.locator('[data-turn-chip="ready"]').nth(1).waitFor({ timeout: 30000 });
    assert.deepEqual((await sent.locator('[data-turn-chip="ready"]').allInnerTexts()).map((s) => /Turn \d+/.exec(s)?.[0]), ["Turn 40", "Turn 290"]);
    await page.waitForTimeout(1500);
    const turnRequests = urls.filter((u) => /\/chat\/sessions\/[^/]+\/turns\//.test(u));
    assert.deepEqual(turnRequests, [], "a sent chip costs no request");
    await kit.shot(page, "02-bubble-chips-after-reload");
    kit.record("2: the sent bubble shows both chips; after a reload they render with no request to /turns/", { requestsAfterReload: urls.length });
  });
}
