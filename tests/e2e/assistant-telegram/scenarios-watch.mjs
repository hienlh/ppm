// Scenarios 5–7 and 13–16: watching chats, relayed cards, answering cards through the Assistant,
// Codex and Claude questions, and the wake turns a watch starts.
import assert from "node:assert/strict";
import { buttonsOf, labelsOf, sleep, until } from "./harness.mjs";
import { answerFromSocket, boundSessionOf, cardOf, startChat } from "./scenarios-sync.mjs";

const WATCH_OPENER = "[PPM] News about a chat you asked me to watch";
const WATCH_NEWS = "🔔 PPM: news about a watched chat";

/** Has the Assistant session bound to `chat` watch `target` (the user asking on Telegram). */
export async function watchFromTelegram(ctx, chat, target, label, provider = "claude") {
  const ask = `${label}: chờ chat đó xong thì báo tôi`;
  await ctx.fx.script(label, [{ mcp: "chat_watch", args: { project: target.project, sessionId: target.sessionId, providerId: provider } }, { text: "Mình sẽ báo khi chat đó xong." }], { match: ask });
  await ctx.tg.send(chat, ask);
  const [rec] = await until(`${label} answered`, async () => { const r = await ctx.fx.recordsOf(label); return r[0]?.done && r; });
  assert.equal(rec.isError, false, rec.text);
  const watch = JSON.parse(rec.text);
  assert.equal(watch.watching, true, rec.text);
  return watch;
}

/** A Telegram chat's own Assistant session, made by its first message. */
async function sessionFor(ctx, chat, label) {
  await ctx.fx.script(label, [{ text: `${label} ready.` }], { match: `${label} hello` });
  await ctx.tg.send(chat, `${label} hello`);
  await ctx.tg.waitText(chat, `${label} ready.`);
  return (await boundSessionOf(ctx, chat)).sessionId;
}

const watchRow = async (ctx, watchId) => (await ctx.fx.tg("watches")).find((w) => w.id === watchId);

/** 5. "Tell me when that chat finishes": the chat finishes, Telegram gets 🔔 and the Assistant's report as a new message. */
async function s5(ctx, chat, owner) {
  const { fx, tg } = ctx;
  const x = await startChat(ctx, { title: "S5 build alpha", text: "S5: build alpha", label: "s5-target", ops: [{ sleep: 5000 }, { text: "Build OK, 0 warnings." }] });
  await fx.script("s5-wake", [{ text: "Chat S5 build alpha đã xong: Build OK." }], { sessionId: owner });
  const watch = await watchFromTelegram(ctx, chat, x, "s5-watch");
  await tg.waitText(chat, WATCH_NEWS, 30000);
  const report = await tg.waitText(chat, "Chat S5 build alpha đã xong: Build OK.", 30000);
  assert.equal(report.history.length, 0, "the report is a new message (it buzzes the phone), not an edit");
  const wake = await fx.turnOf("s5-wake");
  assert.ok(wake.message.includes(WATCH_OPENER), "the turn opens with the fixed sentence");
  assert.ok(wake.message.includes("Build OK, 0 warnings."), "the event carries how the chat ended");
  const row = await until("delivered", async () => { const w = await watchRow(ctx, watch.watchId); return w?.deliveredAt && w; });
  assert.equal(row.lastEvent, "done");
  ctx.record("s5", "telegram", "chat_watch on a running chat: when it finishes Telegram gets '🔔' and the Assistant's report as a new message; the watch is delivered", { watchId: watch.watchId });
}

/** 6. A watched chat asks to run Bash: the card is relayed to Telegram with buttons; Allow there runs it and PPM's card goes. */
async function s6(ctx, dev, chat, watcher) {
  const { fx, tg, kit } = ctx;
  const title = `S6 needs Bash ${dev.name}`;
  const y = await startChat(ctx, { title, text: `S6 (${dev.name}): clean the build`, label: `s6-target-${dev.name}`, ops: [{ sleep: 4000 }, { builtin: "Bash", input: { command: "rm -rf ./build" } }, { text: "Cleaned." }] });
  await fx.script(`s6-wake-${dev.name}`, [{ text: `S6 report ${dev.name}: cleaned.` }], { sessionId: watcher });
  await watchFromTelegram(ctx, chat, y, `s6-watch-${dev.name}`);
  await kit.openChat(dev, "alpha", y.sessionId);
  const ppmCard = kit.card(dev);
  await ppmCard.waitFor({ timeout: 30000 });
  const relayed = await tg.waitFor(chat, "relayed card", (m) => m.text.includes(`Chat “${title}” in alpha needs your decision`) && buttonsOf(m).length > 0);
  assert.deepEqual(labelsOf(relayed), ["Allow", "Deny"]);
  assert.ok(relayed.text.includes("rm -rf ./build"), "the command, verbatim");
  await kit.shot(dev, "s6-watched-chat-card-in-ppm");
  const before = (await tg.answers()).length;
  await tg.pressLabel(chat, relayed, "Allow");
  assert.equal((await tg.answerAfter(before)).text, "Allowed.");
  const [bash] = await until("bash answered", async () => { const r = await fx.recordsOf(`s6-target-${dev.name}`); return r[0]?.done && r; });
  assert.equal(bash.approved, true, "the watched chat ran its command");
  await until("PPM card gone", async () => (await kit.card(dev).count()) === 0, 15000);
  await kit.chatRoot(dev).getByText('Turn "s6-target-' + dev.name + '" done.').first().waitFor({ timeout: 20000 });
  await tg.waitFor(chat, "relayed card closed", (m) => m.message_id === relayed.message_id && buttonsOf(m).length === 0 && /Allowed here/.test(m.text));
  await tg.waitText(chat, `S6 report ${dev.name}: cleaned.`, 30000);
  await kit.shot(dev, "s6-after-allow-from-telegram");
  ctx.record("s6", dev.name, "a watched chat's Bash card is relayed to Telegram with Allow/Deny; Allow there runs it, PPM's card disappears, the relayed card closes and the watch reports");
}

/** 7. "Allow the card in chat X" through the Assistant: a confirmation card; Deny leaves X's card untouched. */
async function s7(ctx, chat) {
  const { fx, tg } = ctx;
  const z = await startChat(ctx, { title: "S7 wants to force-push", text: "S7: push it", label: "s7-target", ops: [{ builtin: "Bash", input: { command: "git push --force origin main" } }] });
  const card = await until("s7 card", () => cardOf(ctx, z.sessionId));
  const ask = "cho phép thẻ ở chat S7 wants to force-push";
  await fx.script("s7-answer", [{ mcp: "chat_answer_approval", args: { project: "alpha", sessionId: z.sessionId, requestId: card.requestId, decision: "allow" } }], { match: ask });
  await tg.send(chat, ask);
  const confirm = await tg.waitFor(chat, "confirmation card", (m) => m.text.includes('Allow "Bash" in a Claude chat in "alpha"') && buttonsOf(m).length > 0);
  assert.ok(confirm.text.includes("git push --force origin main"), "the confirmation repeats the command verbatim");
  assert.deepEqual(labelsOf(confirm), ["Allow", "Deny"]);
  const before = (await tg.answers()).length;
  await tg.pressLabel(chat, confirm, "Deny");
  assert.equal((await tg.answerAfter(before)).text, "Denied.");
  const [rec] = await until("s7 answered", async () => { const r = await fx.recordsOf("s7-answer"); return r[0]?.done && r; });
  assert.equal(rec.isError, true, "not answered");
  const still = await cardOf(ctx, z.sessionId);
  assert.equal(still?.requestId, card.requestId, "chat X still shows its own card, unanswered");
  await answerFromSocket(ctx, z, card.requestId, false);
  ctx.record("s7", "telegram", "chat_answer_approval asks with a confirmation card naming the command; Deny on Telegram leaves the other chat's card waiting");
}

/** 13. Questions answered from Telegram: a Codex chat's two questions (by id) and the Assistant's own Claude question. */
async function s13(ctx, chat, owner, devs) {
  const { fx, tg, kit } = ctx;
  const q = await startChat(ctx, {
    provider: "codex", title: "S13 codex asks", text: "S13: deploy, but ask me first", label: "s13-codex",
    ops: [{ sleep: 4000 }, {
      codexQuestion: { questions: [
        { id: "env", header: "Env", question: "Which environment?", options: [{ label: "staging", description: "safe to break" }, { label: "production" }] },
        { id: "notify", header: "Notify", question: "Tell the team?", options: [{ label: "yes" }, { label: "no" }] },
      ] },
    }, { text: "Deploying." }],
  });
  assert.notEqual(q.sessionId, q.draftId, "the Codex chat was renamed on its first turn");
  await fx.script("s13-wake", [{ text: "S13 codex chat finished." }], { sessionId: owner });
  await watchFromTelegram(ctx, chat, q, "s13-watch", "codex");
  // The web form: both questions, one tab each, every option — not an empty form.
  const formOf = (dev) => kit.chatRoot(dev).getByText("AI has 2 questions").first();
  for (const dev of devs) {
    await kit.openChat(dev, "alpha", q.sessionId, "codex");
    // The Assistant's window would sit over the chat's form.
    await kit.minimizeWindows(dev);
    const root = kit.chatRoot(dev);
    await formOf(dev).waitFor({ timeout: 30000 });
    for (const part of ["Which environment?", "staging", "production"]) await root.getByText(part, { exact: true }).first().waitFor({ timeout: 10000 });
    await kit.shot(dev, "s13-codex-questions-web-form");
    const notifyTab = root.getByRole("button", { name: /Notify/ }).first();
    await notifyTab.click({ timeout: 5000 }).catch(() => notifyTab.dispatchEvent("click"));
    for (const part of ["Tell the team?", "yes", "no"]) await root.getByText(part, { exact: true }).first().waitFor({ timeout: 10000 });
  }
  const relayed = await tg.waitFor(chat, "relayed question card", (m) => m.text.includes("Which environment?") && buttonsOf(m).length > 0);
  assert.ok(relayed.text.includes("Tell the team?"));
  for (const label of ["Env: staging", "Notify: yes"]) {
    const n = (await tg.answers()).length;
    await tg.pressLabel(chat, await tg.message(chat, relayed.message_id), label);
    assert.equal((await tg.answerAfter(n)).text, "Ticked.");
  }
  await until("ticks shown", async () => labelsOf(await tg.message(chat, relayed.message_id)).filter((l) => l.startsWith("✓")).length === 2, 15000);
  const n = (await tg.answers()).length;
  await tg.pressLabel(chat, await tg.message(chat, relayed.message_id), "Send");
  assert.equal((await tg.answerAfter(n)).text, "Answer sent.");
  const [asked] = await until("codex answered", async () => { const r = await fx.recordsOf("s13-codex"); return r[0]?.done && r; });
  assert.deepEqual(asked.answer, { env: ["staging"], notify: ["yes"] }, "Codex receives its answers by question id");
  for (const dev of devs) await until(`web form gone (${dev.name})`, async () => (await kit.chatRoot(dev).getByText("AI has 2 questions").count()) === 0, 15000);
  await tg.waitText(chat, "S13 codex chat finished.", 30000);

  // The Assistant's own question, shaped as Claude's AskUserQuestion.
  const ask = "S13: hỏi tôi chọn màu";
  await fx.script("s13-claude", [{ builtin: "AskUserQuestion", input: { questions: [{ question: "Màu nào?", header: "Màu", options: [{ label: "Đỏ" }, { label: "Xanh" }], multiSelect: false }] } }], { match: ask });
  await tg.send(chat, ask);
  const own = await tg.waitFor(chat, "own question card", (m) => m.text.includes("Màu nào?") && buttonsOf(m).length > 0);
  assert.deepEqual(labelsOf(own), ["Đỏ", "Xanh"], "one question, one choice: a button per option");
  const m = (await tg.answers()).length;
  await tg.pressLabel(chat, own, "Xanh");
  assert.equal((await tg.answerAfter(m)).text, "Answer sent.");
  const [claude] = await until("claude answered", async () => { const r = await fx.recordsOf("s13-claude"); return r[0]?.done && r; });
  assert.deepEqual(claude.answer, { "Màu nào?": "Xanh" }, "Claude receives its answer keyed by the question's text");
  ctx.record("s13", "desktop+phone", "a Codex chat's two questions show as a full web form and are answered on Telegram by ticking + Send (Codex gets {id: answers}); the Assistant's Claude question is answered with one tap");
}

/** 14. A wake turn that fails three times becomes a push naming the chat; ten cards of a watched chat wake nothing. */
async function s14(ctx, chat) {
  const { fx, tg } = ctx;
  const watcher = await sessionFor(ctx, chat, "s14");
  const x = await startChat(ctx, { title: "S14 flaky report target", text: "S14: quick job", label: "s14-target", ops: [{ sleep: 4000 }, { text: "Quick job done." }] });
  for (const n of [1, 2, 3]) await fx.script(`s14-wake-${n}`, [{ fail: `wake turn crashed (${n})` }], { sessionId: watcher });
  const pushesBefore = (await fx.tg("pushes")).length;
  const watch = await watchFromTelegram(ctx, chat, x, "s14-watch");
  for (const n of [1, 2]) {
    await until(`wake attempt ${n}`, () => fx.turnOf(`s14-wake-${n}`), 60000);
    await sleep(500);
    const row = await watchRow(ctx, watch.watchId);
    assert.equal(row.deliveredAt ?? null, null, `not delivered after failed attempt ${n}`);
  }
  await until("wake attempt 3", () => fx.turnOf("s14-wake-3"), 60000);
  // The watch's own push (the watched chat's ordinary "Chat completed" names it too, in its body).
  const push = await until("push naming the chat", async () => (await fx.tg("pushes")).slice(pushesBefore).find((p) => p.title.includes("S14 flaky report target")), 30000);
  assert.match(push.title, /^Chat finished: S14 flaky report target/);
  assert.match(push.body, /could not write a report/);
  const row = await until("delivered once pushed", async () => { const w = await watchRow(ctx, watch.watchId); return w?.deliveredAt && w; });
  assert.ok(row.deliveredAt >= push.at - 1000, "delivered only once the push went");

  // Ten cards in a watched chat: ten relayed cards, no wake turn until it ends.
  const many = await startChat(ctx, {
    title: "S14 ten commands", text: "S14: run ten commands", label: "s14-ten",
    ops: [{ sleep: 3000 }, ...Array.from({ length: 10 }, (_, i) => ({ builtin: "Bash", input: { command: `echo step-${i + 1}` } })), { text: "All ten ran." }],
  });
  await fx.script("s14-ten-wake", [{ text: "S14 ten commands finished." }], { sessionId: watcher });
  await watchFromTelegram(ctx, chat, many, "s14-watch-ten");
  const turnsBefore = (await fx.state()).turns.filter((t) => t.sessionId === watcher).length;
  for (let i = 1; i <= 10; i++) {
    const card = await tg.waitFor(chat, `relayed card ${i}`, (m) => m.text.includes(`echo step-${i}`) && buttonsOf(m).length > 0, 30000);
    await tg.pressLabel(chat, card, "Allow");
  }
  const ran = await until("ten ran", async () => { const r = await fx.recordsOf("s14-ten"); return r.length === 10 && r.every((c) => c.done) && r; }, 60000);
  assert.ok(ran.every((c) => c.approved), "all ten allowed from Telegram");
  const relayedCount = (await tg.sent(chat)).filter((m) => /Chat “S14 ten commands” in alpha needs your decision/.test(m.text)).length;
  assert.equal(relayedCount, 10, "ten relayed cards");
  const turnsDuring = (await fx.state()).turns.filter((t) => t.sessionId === watcher && t.at < Date.now()).length;
  await tg.waitText(chat, "S14 ten commands finished.", 30000);
  const wakeTurns = (await fx.turnsOf("s14-ten-wake")).length;
  assert.equal(turnsDuring - turnsBefore <= 1, true, `no wake turn per card (${turnsDuring - turnsBefore} turns, the final report included)`);
  assert.equal(wakeTurns, 1, "one wake turn, when the chat ended");
  ctx.record("s14", "telegram", "a wake turn failing 3 times ends in a web push naming the watched chat, delivered only then; 10 cards of a watched chat are 10 relayed cards and no wake turn until it ends", { push: push.title });
}

/** 15. A wake turn can change nothing: chat_start and Bash in it are refused without a card. */
async function s15(ctx, chat) {
  const { fx, tg } = ctx;
  const watcher = await sessionFor(ctx, chat, "s15");
  const x = await startChat(ctx, { title: "S15 target", text: "S15: tiny job", label: "s15-target", ops: [{ sleep: 3000 }, { text: "Tiny job done." }] });
  await fx.script("s15-wake", [
    { mcp: "chat_start", args: { project: "alpha", text: "Do something the report suggested" } },
    { builtin: "Bash", input: { command: "echo injected" } },
    { text: "S15 wake turn tried and was refused." },
  ], { sessionId: watcher });
  await watchFromTelegram(ctx, chat, x, "s15-watch");
  const sentBefore = (await tg.sent(chat)).length;
  await tg.waitText(chat, "S15 wake turn tried and was refused.", 30000);
  const [start, bash] = await fx.recordsOf("s15-wake");
  assert.equal(start.isError, true);
  assert.match(start.text, /Refused without asking the user/);
  assert.equal(bash.decision, "ask");
  assert.equal(bash.approved, false, "the provider's card was refused at once");
  const after = (await tg.sent(chat)).slice(sentBefore);
  assert.ok(!after.some((m) => buttonsOf(m).length > 0), "no card reached Telegram");
  ctx.record("s15", "telegram", "in a wake turn chat_start is refused by the endpoint and a Bash card is refused by PPM, without any card on Telegram");
}

/** 16. A watch set from an Assistant session no chat is bound to reports to every connected chat, and a push names the chat. */
async function s16(ctx, dev, chats) {
  const { fx, tg, kit } = ctx;
  const x = await startChat(ctx, { title: "S16 unbound target", text: "S16: job for nobody's phone", label: "s16-target", ops: [{ sleep: 6000 }, { text: "S16 job done." }] });
  // A new Assistant session in PPM, the way a browser starts one, that no Telegram chat talks to.
  await startChat(ctx, { project: "__assistant__", text: "S16 watch from PPM", label: "s16-watch", ops: [{ mcp: "chat_watch", args: { project: "alpha", sessionId: x.sessionId } }] });
  const [rec] = await until("s16 watch set", async () => { const r = await fx.recordsOf("s16-watch"); return r[0]?.done && r; });
  assert.equal(JSON.parse(rec.text).watching, true, rec.text);
  const unbound = (await fx.turnOf("s16-watch")).sessionId;
  assert.ok(!(await fx.tg("bindings")).some((b) => b.sessionId === unbound), "no Telegram chat talks to this session");
  await fx.script("s16-wake", [{ text: "S16 unbound target finished its job." }], { sessionId: unbound });
  const pushesBefore = (await fx.tg("pushes")).length;
  for (const chat of chats) {
    const m = await tg.waitFor(chat, "watch report", (x2) => x2.text.includes("🔔") && x2.text.includes("S16 unbound target"), 40000);
    assert.ok(m.text.includes("S16 unbound target finished its job."), `chat ${chat} got the report`);
  }
  // The watch's own push (the watched chat's ordinary "Chat completed" names it too, in its body).
  const push = await until("push names the chat", async () => (await fx.tg("pushes")).slice(pushesBefore).find((p) => p.title.includes("S16 unbound target")), 30000);
  assert.match(push.title, /^Chat finished: S16 unbound target/);
  assert.ok(new URLSearchParams(push.path.split("?")[1] ?? "").get("session")?.endsWith(unbound), `the push opens the Assistant session (${push.path})`);
  await kit.openLink(dev, `${ctx.web}${push.path}`);
  await kit.chatRoot(dev).getByText("S16 unbound target finished its job.").first().waitFor({ timeout: 20000 });
  await kit.shot(dev, "s16-unbound-session-watch");
  ctx.record("s16", dev.name, "a watch from an unbound Assistant session reports to every connected chat and sends a web push naming the watched chat", { chats, push: push.title });
}

export function plan(ctx, state, { desk, mobile }) {
  const { CHATS } = ctx;
  return [
    ["s5", "telegram", [CHATS.owner], () => s5(ctx, CHATS.owner, state.owner)],
    ["s6", "desktop", [CHATS.owner], () => s6(ctx, desk, CHATS.owner, state.owner)],
    ["s6", "phone", [CHATS.phoneRun], () => s6(ctx, mobile, CHATS.phoneRun, state.phoneRun)],
    ["s7", "telegram", [CHATS.owner], () => s7(ctx, CHATS.owner)],
    ["s13", "desktop+phone", [CHATS.owner], () => s13(ctx, CHATS.owner, state.owner, [desk, mobile])],
    ["s14", "telegram", [CHATS.failedWake], () => s14(ctx, CHATS.failedWake)],
    ["s15", "telegram", [CHATS.quietWake], () => s15(ctx, CHATS.quietWake)],
    ["s16", "desktop", [CHATS.owner, CHATS.second], () => s16(ctx, desk, [CHATS.owner, CHATS.second])],
  ];
}
