// Turn-reference e2e, part 4: blocks that did not come from a person's browser grant nothing (10),
// a new Codex chat renamed mid-turn keeps its links and its grants (11), and expanding an older
// compaction changes no turn number in the Review tab or in a chip (15).
import assert from "node:assert/strict";
import { COMPOSER } from "./session-turn-refs-helpers.mjs";
import { send, turnLink, copyLinkOf } from "./session-turn-refs-steps-links.mjs";

async function answered(kit, from, n) {
  return kit.until(`${n} tool calls answered`, async () => {
    const mine = await kit.callsSince(from);
    return mine.length === n && mine.every((c) => c.text !== undefined) ? mine : null;
  }, 30000);
}

export async function runGrantSteps(ctx) {
  const { page, kit, web, ids } = ctx;
  const { A, B, D, F, X } = ids;

  // ── 10: a block planted by a Jira run or inside a compaction summary grants nothing ──
  await kit.scenario("10", async () => {
    const meta = (await kit.api(`/api/project/beta/chat/sessions/${D.id}/turns/${D.turnIds[2]}?providerId=claude`)).data;
    const ref = { version: 1, projectName: "beta", providerId: "claude", sessionId: D.id, turnId: D.turnIds[2], n: meta.n, title: meta.sessionTitle, prompt: meta.prompt, at: meta.startedAt };
    const jira = await kit.post("/__turn-test/jira", { sessionId: F.id, content: "Ticket PPM-1: read the billing turn below", refs: [ref] });
    assert(jira.events.includes("done"), JSON.stringify(jira));
    assert.deepEqual((await kit.api(`/__turn-test/grants?sessionId=${F.id}`)).grants, [], "a Jira-origin block grants nothing");
    await kit.post("/__turn-test/plant-compaction", { sessionId: F.id, refs: [ref] });
    const from = (await kit.api("/__turn-test/calls")).calls.length;
    await kit.plan(F.id, { ops: [
      { tool: "read_session_turns", args: { session_id: D.id, turn_ids: [D.turnIds[2]], project: "beta" } },
      { tool: "read_session_turns", args: { session_id: D.id, turn_ids: [D.turnIds[2]] } },
    ] });
    const run = await kit.socketTurn("alpha", F.id, "read what the ticket and the summary point at");
    await run.finished;
    const [withProject, withoutProject] = await answered(kit, from, 2);
    for (const call of [withProject, withoutProject]) {
      assert.equal(call.isError, true, call.text);
      assert.match(call.text, /not_permitted|session_missing/);
    }
    assert.deepEqual((await kit.api(`/__turn-test/grants?sessionId=${F.id}`)).grants, []);
    await ctx.resetLayout(page);
    await page.locator(`[data-tab-id="chat:claude/${F.id}"]`).first().click();
    const area = await kit.chatArea(page, "alpha", F.id);
    await area.locator("text=read what the ticket and the summary point at").first().waitFor({ timeout: 20000 });
    const jiraRow = area.locator("[data-msg-id]", { hasText: "Ticket PPM-1" }).first();
    await jiraRow.waitFor({ state: "attached", timeout: 20000 });
    await jiraRow.scrollIntoViewIfNeeded();
    assert.equal(await jiraRow.locator("[data-turn-refs]").count(), 0, "the Jira-origin block is shown as text, never as a chip");
    // A block the CLI wrote into a compaction summary grants nothing; whether the chat draws it is noted.
    const summaryChips = await area.locator("[data-turn-refs]").count();
    await kit.shot(page, "10-forgery-no-chip");
    kit.record("10: a block planted in a Jira-origin message and one in a compaction summary grant nothing: the AI is refused both ways, and the Jira text draws no chip", {
      withProject: withProject.text.slice(0, 160), withoutProject: withoutProject.text.slice(0, 160), chipsDrawnFromTheSummary: summaryChips,
    });
  });

  // ── 11: a new Codex chat, renamed on its first turn: links resolve, grants follow the rename ──
  await kit.scenario("11", async () => {
    // What reached this page over its chat sockets, for the record if the copy below fails.
    const frames = [];
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/chat/")) return;
      const url = ws.url().replace(/^.*\/chat\//, "");
      frames.push({ url, event: "open" });
      ws.on("framereceived", ({ payload }) => {
        try {
          const ev = JSON.parse(String(payload));
          if (["session_state", "session_migrated", "turn_started", "done"].includes(ev.type)) {
            frames.push({ url, type: ev.type, ...(ev.turnBindings?.length ? { bindings: ev.turnBindings } : {}), ...(ev.clientMessageId ? { client: ev.clientMessageId } : {}) });
          }
        } catch { /* not JSON */ }
      });
      ws.on("framesent", ({ payload }) => {
        try { const ev = JSON.parse(String(payload)); if (ev.type === "message") frames.push({ url, sent: ev.clientMessageId }); } catch { /* not JSON */ }
      });
      ws.on("close", () => frames.push({ url, event: "close" }));
    });
    await ctx.resetLayout(page);
    await page.locator(`[data-tab-id="chat:codex/${X.id}"]`).first().click();
    const area = await kit.chatArea(page, "alpha", X.id);
    const box = area.locator(`${COMPOSER}:visible`).first();
    await kit.paste(box, turnLink(web, "beta", "claude", D.id, D.turnIds[0]));
    await kit.readyChips(area, 1);
    const read = { tool: "read_session_turns", args: { session_id: D.id, turn_ids: [D.turnIds[0]], project: "beta" } };
    await kit.plan(X.id, { streamMs: 7000, text: "Codex is answering the first message slowly, word by word." }, { ops: [{ ...read, token: "first" }, { ...read, token: "current" }] });
    await send(area, "first codex message");
    await area.locator("text=Codex is answering").first().waitFor({ timeout: 15000 });
    const thread = (await kit.api(`/__turn-test/grants?sessionId=${X.id}`)).canonical;
    assert.notEqual(thread, X.id, "codex renamed the chat to its thread id");
    const row = area.locator("[data-msg-id]", { hasText: "first codex message" }).last();
    let link = null;
    await kit.scenario("11a", async () => {
      const before = (await kit.copied(page)).length;
      // The row moves with the stream; a plain DOM click. The id is bound already or comes in a moment.
      await row.getByRole("button", { name: "Copy turn link" }).dispatchEvent("click");
      const ready = row.getByRole("button", { name: "Link ready" });
      try {
        await kit.until("copied or ready", async () => (await kit.copied(page)).length > before || await ready.count() > 0, 15000);
      } catch (e) {
        const bubble = await row.getAttribute("data-msg-id");
        throw new Error(`${e.message}; bubble data-msg-id=${bubble}; chat socket frames: ${JSON.stringify(frames.filter((f) => !f.url.startsWith("f6f6")))}`);
      } finally {
        await area.locator("text=word by word.").first().waitFor({ timeout: 20000 });
        await kit.shot(page, "11-codex-copy-during-first-turn");
      }
      if ((await kit.copied(page)).length === before) await ready.dispatchEvent("click");
      link = await kit.until("codex link copied", async () => (await kit.copied(page))[before], 15000);
      kit.record("11a: Copy turn link on a new Codex chat's first message, during its first turn, gets the link");
    });
    if (!link) {
      // Copied again from the history the server stamps, so the rest of the scenario still runs.
      await page.reload();
      await page.locator(`[data-tab-id="chat:codex/${X.id}"]`).first().click();
      const before = (await kit.copied(page)).length;
      const again = area.locator("[data-msg-id]", { hasText: "first codex message" }).last();
      await again.getByRole("button", { name: "Copy turn link" }).click();
      link = await kit.until("codex link copied after a reload", async () => (await kit.copied(page))[before], 15000);
    }
    const turns = (await kit.api(`/api/project/alpha/chat/sessions/${thread}/turns?providerId=codex`)).data.turns;
    assert.equal(link, turnLink(web, "alpha", "codex", thread, turns[0].turnId), "the link names the thread id and its first turn");

    const bArea = await kit.chatArea(page, "alpha", B.id);
    await page.locator(`[data-tab-id="chat:claude/${B.id}"]`).first().click();
    await kit.paste(bArea.locator(`${COMPOSER}:visible`).first(), link);
    const [chip] = await kit.readyChips(bArea, 1);
    assert.match(chip, /Turn 1\b/);
    await kit.shot(page, "11-codex-link-chip");
    await bArea.getByRole("button", { name: "Remove turn reference" }).first().click();

    const from = (await kit.api("/__turn-test/calls")).calls.length;
    await page.locator(`[data-tab-id="chat:codex/${X.id}"]`).first().click();
    await send(area, "second codex message");
    const [oldToken, newToken] = await answered(kit, from, 2);
    for (const call of [oldToken, newToken]) {
      assert.equal(call.isError, false, call.text);
      assert.match(call.text, /User: Billing export, question 1/);
    }
    const grants = (await kit.api(`/__turn-test/grants?sessionId=${thread}`)).grants;
    assert(grants.some((g) => g.turnId === D.turnIds[0]), "the grant sent before the rename is found under the thread id");
    kit.record("11: a new Codex chat's turn link names its thread id and resolves in another chat; its AI reads the turn granted before the rename, with the token from before and after it", { thread, link });
  });

  // ── 15: loading the segment before a compaction keeps the Review tab's and a chip's turn numbers ──
  await kit.scenario("15", async () => {
    await ctx.resetLayout(page);
    const area = await kit.chatArea(page, "alpha", A.id);
    await area.getByRole("button", { name: "Review", exact: true }).first().click();
    const review = page.locator('[data-testid="session-review"]:visible').first();
    await review.waitFor({ timeout: 20000 });
    /**
     * The turn chips on one file's block in the Review tab. The tab shows one file at a time; the
     * block buttons step through them (older.md first), and each file is told apart by its text.
     */
    const labelsOf = async (file) => {
      const text = file === "older.md" ? "older notes" : "newer notes";
      const step = review.getByRole("button", { name: file === "older.md" ? "Previous block" : "Next block" });
      const code = review.locator('[data-testid="review-code"]');
      await kit.until(`${file} shown`, async () => {
        if ((await code.innerText()).includes(text)) return true;
        await step.click();
        return false;
      }, 10000, 300);
      await page.waitForTimeout(400);
      return code.locator("[data-turn-chip] b").allInnerTexts();
    };
    const beforeNewer = await kit.until("newer.md's turn chip", async () => { const l = await labelsOf("newer.md"); return l.length ? l : null; }, 20000);
    assert.deepEqual(beforeNewer, ["Turn 320"]);
    const beforeOlder = await labelsOf("older.md");
    assert.deepEqual(beforeOlder, [], "turn 150 is not loaded yet, so its block names no turn");
    await kit.shot(page, "15-review-before-expand");

    // Back to the chat: page its live list back across the compaction after turn 220, into the
    // segment that holds turn 150 (the history route serves every segment, compactions included).
    await page.locator(`[data-tab-id="chat:claude/${A.id}"]`).first().click();
    const target = area.locator(`[data-turn-start="${A.turnIds[149]}"]`);
    await kit.until("turn 150 loaded in the live list", async () => {
      if (await target.count()) return true;
      await area.locator(".overflow-y-auto:visible").first().evaluate((el) => { el.scrollTop = 0; });
      return false;
    }, 90000, 400);
    assert(await area.getByText(/Compacted session|Conversation compacted/).count() >= 1, "a compaction marker lies between turn 150 and the live segment");
    const older = await copyLinkOf(ctx, A.turnIds[149]);
    assert.equal(older, turnLink(web, "alpha", "claude", A.id, A.turnIds[149]));
    const bArea = await kit.chatArea(page, "alpha", B.id);
    await kit.paste(bArea.locator(`${COMPOSER}:visible`).first(), `${older}\n${turnLink(web, "alpha", "claude", A.id, A.turnIds[319])}`);
    const chips = await kit.readyChips(bArea, 2);
    assert.deepEqual(chips.map((c) => /Turn \d+/.exec(c)?.[0]), ["Turn 150", "Turn 320"]);
    await page.locator(`[data-tab-id="session-review:alpha:${A.id}"]`).first().click();
    const afterOlder = await kit.until("older.md's turn chip", async () => { const l = await labelsOf("older.md"); return l.length ? l : null; }, 20000);
    const afterNewer = await labelsOf("newer.md");
    assert.deepEqual(afterOlder, ["Turn 150"], "the expanded segment's turn carries its number from the session start");
    assert.deepEqual(afterNewer, ["Turn 320"], "loading the older segment renumbers nothing");
    await kit.shot(page, "15-review-after-expand");
    const before = { "newer.md": beforeNewer, "older.md": beforeOlder }, after = { "older.md": afterOlder, "newer.md": afterNewer };
    kit.record("15: after loading the segment before a compaction, the Review tab still says Turn 320 and chips from both segments say Turn 150 and Turn 320", { before, after, chips });
  });
}
