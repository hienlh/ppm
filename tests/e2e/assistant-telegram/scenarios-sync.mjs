// Scenarios 1–4 and 21: one conversation in two windows (Telegram ↔ PPM), the overview of chats
// that need the user, opening a chat from Telegram, and the "Open in PPM" link.
import assert from "node:assert/strict";
import { buttonsOf, labelsOf, sleep, until } from "./harness.mjs";

/** The Assistant session a Telegram chat talks to, once it has one. */
export async function boundSessionOf(ctx, chatId, timeout = 15000) {
  return until(`chat ${chatId} bound`, async () => (await ctx.fx.tg("bindings")).find((b) => b.telegramChatId === String(chatId)), timeout);
}

/** 1. Telegram → PPM: a first message creates and binds a session the open Assistant lists at once, and both show the exchange. */
export async function s1(ctx, dev, chat) {
  const { fx, tg, kit } = ctx;
  await kit.openAssistant(dev);
  const pane = await kit.sessionsPane(dev);
  const hello = `xin chào (${dev.name})`;
  // A model takes a moment to answer; the list is announced again once this first turn ends.
  await fx.script(`s1-hello-${dev.name}`, [{ sleep: 800 }, { text: `Chào bạn, mình là PPM Assistant (${dev.name}).` }], { match: hello });
  await tg.send(chat, hello);
  const binding = await boundSessionOf(ctx, chat);
  const boundAt = Date.now();
  const row = kit.sessionRow(pane, hello);
  await row.waitFor({ timeout: 10000 });
  const listedMs = Date.now() - boundAt;
  assert.ok(listedMs <= 2000, `the new session was listed ${listedMs} ms after it was bound (≤ 2 s)`);
  const answer = await tg.waitText(chat, `Chào bạn, mình là PPM Assistant (${dev.name}).`);
  assert.ok(answer.text.includes(`Turn "s1-hello-${dev.name}" done.`), "the final answer is the whole answer");
  // The row says a Telegram chat talks to it.
  await row.locator('[data-testid="assistant-session-telegram"]').waitFor({ timeout: 10000 });
  await kit.shot(dev, "s1-session-listed-with-telegram-label");
  await row.click();
  const root = kit.chatRoot(dev);
  await root.getByText(hello).first().waitFor({ timeout: 15000 });
  await root.getByText(`Chào bạn, mình là PPM Assistant (${dev.name}).`).first().waitFor({ timeout: 15000 });
  // The next phone message streams into the open session, with no reload.
  const more = `kể thêm đi (${dev.name})`;
  await fx.script(`s1-more-${dev.name}`, [{ text: `Đây là phần kể thêm (${dev.name}).` }], { match: more });
  await tg.send(chat, more);
  await root.getByText(more).first().waitFor({ timeout: 15000 });
  await root.getByText(`Đây là phần kể thêm (${dev.name}).`).first().waitFor({ timeout: 15000 });
  await tg.waitText(chat, `Đây là phần kể thêm (${dev.name}).`);
  const turn = await fx.turnOf(`s1-more-${dev.name}`);
  assert.equal(turn.sessionId, binding.sessionId, "the second message went to the same bound session");
  assert.equal(turn.assistant, true, "it ran as an Assistant session");
  await kit.shot(dev, "s1-telegram-messages-live-in-ppm");
  ctx.record("s1", dev.name, "a Telegram message creates and binds an Assistant session, listed with its Telegram label in ≤ 2 s; the next message and answer stream into the open session", { listedMs });
  return binding.sessionId;
}

/** 2. PPM → Telegram: typed in the bound session, the phone sees the message and the answer, edited as it grows. */
export async function s2(ctx, dev, chat, sessionId) {
  const { fx, tg, kit } = ctx;
  const typed = `câu hỏi gõ ở PPM (${dev.name})`;
  await fx.script(`s2-ppm-${dev.name}`, [{ text: "Phần đầu của câu trả lời." }, { sleep: 2500 }, { text: " Phần cuối." }], { sessionId });
  await kit.typeAndSend(dev, typed);
  const mirrored = await tg.waitText(chat, `🖥 (PPM) ${typed}`);
  assert.ok(mirrored, "the typed message is shown on Telegram");
  const final = await tg.waitFor(chat, "final answer", (m) => m.text.includes("Phần cuối.") && m.text.includes(`Turn "s2-ppm-${dev.name}" done.`));
  assert.ok(final.history.length >= 1, `the answer was edited as it grew (${final.history.length} earlier texts)`);
  assert.ok(final.history.some((h) => h.includes("Phần đầu") && !h.includes("Phần cuối")), "an earlier edit held only the first part");
  assert.ok(!final.text.trimEnd().endsWith("…"), "the final text has no draft mark");
  assert.ok(final.text.startsWith("Phần đầu của câu trả lời. Phần cuối."), `final text: ${final.text.slice(0, 120)}`);
  await kit.shot(dev, "s2-typed-in-ppm");
  ctx.record("s2", dev.name, "a message typed in PPM is mirrored as '🖥 (PPM) …' and its answer is edited in place until the final text", { edits: final.history.length });
}

/** Starts an ordinary chat through its own socket, the way a browser tab would, and leaves it running. */
export async function startChat(ctx, { project = "alpha", provider = "claude", title, text, ops, mode = "default", label, keepSocket = false }) {
  const { fx } = ctx;
  const draft = (await fx.post(`/api/project/${project}/chat/sessions`, { providerId: provider, title })).data.id;
  await fx.script(label, ops, { match: text });
  const socket = new WebSocket(`${ctx.wsBase}/ws/project/${project}/chat/${draft}?providerId=${provider}`);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  socket.send(JSON.stringify({ type: "message", content: text, permissionMode: mode, clientMessageId: crypto.randomUUID() }));
  const turn = await until(`${label} started`, () => fx.turnOf(label), 30000);
  // Named as a user names a chat, so every card and report about it can say which chat it is.
  if (title) await fx.post("/__assistant-test/tg/title", { sessionId: turn.sessionId, title });
  if (!keepSocket) socket.close();
  return { sessionId: turn.sessionId, draftId: draft, project, provider, socket: keepSocket ? socket : null };
}

/** Answers a card from a socket of its own, as a browser tab holding that chat would. */
export async function answerFromSocket(ctx, { project, sessionId, provider = "claude" }, requestId, approved, extra = {}) {
  const socket = new WebSocket(`${ctx.wsBase}/ws/project/${project}/chat/${sessionId}?providerId=${provider}`);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  socket.send(JSON.stringify({ type: "approval_response", requestId, approved, ...extra }));
  await sleep(300);
  socket.close();
}

export async function cancelFromSocket(ctx, { project, sessionId, provider = "claude" }) {
  const socket = new WebSocket(`${ctx.wsBase}/ws/project/${project}/chat/${sessionId}?providerId=${provider}`);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  socket.send(JSON.stringify({ type: "cancel" }));
  await sleep(300);
  socket.close();
}

export const liveOf = async (ctx, sessionId) => (await ctx.fx.tg("live")).find((l) => l.sessionId === sessionId);
export const cardOf = async (ctx, sessionId) => (await liveOf(ctx, sessionId))?.card ?? null;

/** 3. "Which chats need me today?" from Telegram, over chats nobody has open — one never opened in this process at all. */
export async function s3(ctx, chat) {
  const { fx, tg } = ctx;
  const waiting = await startChat(ctx, { project: "alpha", title: "S3 waiting on Bash", text: "S3: build it", label: "s3-waiting", ops: [{ builtin: "Bash", input: { command: "npm run build" } }] });
  await until("s3 card up", () => cardOf(ctx, waiting.sessionId));
  const unread = await startChat(ctx, { project: "beta", title: "S3 finished unread", text: "S3: summarise beta", label: "s3-unread", ops: [{ text: "Beta summarised." }] });
  const failed = await startChat(ctx, { project: "alpha", title: "S3 stopped on error", text: "S3: refactor", label: "s3-error", ops: [{ text: "Starting." }, { error: "Model overloaded: try again later" }] });
  const running = await startChat(ctx, { project: "beta", title: "S3 still running", text: "S3: long job", label: "s3-running", ops: [{ sleep: 180000 }] });
  const never = { sessionId: crypto.randomUUID(), project: "beta" };
  await fx.post("/__assistant-test/tg/seed-unread", { sessionId: never.sessionId, project: "beta", path: ctx.paths.beta, providerId: "claude", title: "S3 never opened here" });
  await until("s3 chats settled", async () => !(await liveOf(ctx, unread.sessionId))?.running && !(await liveOf(ctx, failed.sessionId))?.running);

  const ask = "hôm nay chat nào chờ tôi quyết định?";
  await fx.script("s3-overview", [{ mcp: "chats_attention", args: { since: "today" } }, { text: "Có một chat đang chờ bạn quyết định: S3 waiting on Bash." }], { match: ask });
  await tg.send(chat, ask);
  const [rec] = await until("s3 overview answered", async () => { const r = await fx.recordsOf("s3-overview"); return r[0]?.done && r; });
  assert.equal(rec.isError, false, rec.text);
  const o = JSON.parse(rec.text);
  const ids = (group) => o[group].map((c) => c.sessionId);
  assert.ok(ids("needsDecision").includes(waiting.sessionId), "the chat on a card needs a decision");
  const card = o.needsDecision.find((c) => c.sessionId === waiting.sessionId).card;
  assert.equal(card.deciding.text, "npm run build", "its card's command is shown as it will run");
  assert.ok(ids("running").includes(running.sessionId), "the sleeping chat is running");
  assert.ok(ids("stopped").includes(failed.sessionId), "the chat ended by an error is stopped");
  assert.match(o.stopped.find((c) => c.sessionId === failed.sessionId).error, /Model overloaded/);
  assert.ok(ids("finishedUnread").includes(unread.sessionId), "the finished chat nobody read is unread");
  assert.ok(ids("finishedUnread").includes(never.sessionId), "the chat known only from the database is unread too");
  assert.equal(o.finishedUnread.find((c) => c.sessionId === never.sessionId).title, "S3 never opened here");
  await tg.waitText(chat, "Có một chat đang chờ bạn quyết định: S3 waiting on Bash.");
  ctx.record("s3", "telegram", "chats_attention from Telegram sorts a waiting card, a running chat, an error stop and two unread chats (one known only from the DB) into their groups, and the answer reaches Telegram", {
    groups: Object.fromEntries(["needsDecision", "running", "stopped", "finishedUnread"].map((g) => [g, o[g].length])),
  });
  // Left for later scenarios to find; the long job stops now.
  await cancelFromSocket(ctx, running);
  return { waiting };
}

/** 4. "Open a new chat…" → a card on Telegram and in PPM; Allow on Telegram starts it in the mode the card named. */
export async function s4(ctx, dev, chat, sessionId) {
  const { fx, tg, kit } = ctx;
  const first = `S4 (${dev.name}): list the files in README`;
  const label = `s4-start-${dev.name}`;
  await fx.script(`s4-target-${dev.name}`, [{ text: "README.md, notes.txt" }], { match: first });
  const ask = `mở chat mới ở alpha để liệt kê file (${dev.name})`;
  await fx.script(label, [{ mcp: "chat_start", args: { project: "alpha", text: first, permissionMode: "default", title: `S4 list files ${dev.name}` } }], { match: ask });
  await tg.send(chat, ask);
  const tgCard = await tg.waitFor(chat, "chat_start card", (m) => m.text.includes("Start a new Claude chat in \"alpha\"") && buttonsOf(m).length > 0);
  assert.deepEqual(labelsOf(tgCard), ["Allow", "Deny"], "Allow and Deny; the link is in the text (no tunnel)");
  assert.ok(tgCard.text.includes(first), "the card shows the whole first message");
  assert.match(tgCard.text, /Runs in: Ask before risky tools \(default\)/);
  const ppmCard = kit.card(dev);
  await ppmCard.waitFor({ timeout: 15000 });
  assert.ok((await ppmCard.innerText()).includes(first), "PPM shows the same card");
  await kit.shot(dev, "s4-chat-start-card-in-ppm");
  const before = (await tg.answers()).length;
  const allow = await tg.pressLabel(chat, tgCard, "Allow");
  assert.equal((await tg.answerAfter(before)).text, "Allowed.");
  const [rec] = await until("chat_start answered", async () => { const r = await fx.recordsOf(label); return r[0]?.done && r; });
  assert.equal(rec.isError, false, rec.text);
  const started = JSON.parse(rec.text);
  assert.equal(started.started, true);
  assert.equal(started.permissionMode, "default", "the chat runs in the mode the card named");
  const target = await until("new chat ran", () => fx.turnOf(`s4-target-${dev.name}`));
  assert.equal(target.sessionId, started.sessionId);
  assert.equal(target.assistant, false, "an ordinary chat, not an Assistant session");
  assert.equal(target.mode, "default", "its first turn ran in that mode");
  const listed = (await fx.api("/api/project/alpha/chat/sessions")).data.sessions.map((s) => s.id);
  assert.ok(listed.includes(started.sessionId), "the new chat is one of alpha's");
  await until("PPM card gone", async () => (await kit.card(dev).count()) === 0, 15000);
  await tg.waitFor(chat, "card closed", (m) => m.message_id === tgCard.message_id && /Allowed here/.test(m.text) && buttonsOf(m).length === 0);
  // The same button again: nothing is waiting on it any more.
  const again = (await tg.answers()).length;
  await tg.press(chat, tgCard.message_id, allow, { stale: true });
  assert.match((await tg.answerAfter(again)).text, /no longer valid/);
  await kit.shot(dev, "s4-after-allow-card-gone");
  ctx.record("s4", dev.name, "chat_start from Telegram: card with buttons on Telegram and in PPM; Allow on Telegram starts the alpha chat in the card's mode, PPM's card goes, a second press is 'no longer valid'", { chat: started.sessionId });
  return { link: tgCard.text.match(/Open in PPM: (\S+)/)?.[1], started };
}

/** 21. No tunnel: "Open in PPM" is a line of text, not a URL button; the link opens that Assistant session. */
export async function s21(ctx, chat, sessionId, other) {
  const { tg, kit, fx } = ctx;
  // A card of the session's own, which carries the link back into PPM.
  await fx.script("s21-card", [{ builtin: "Bash", input: { command: "echo s21" } }], { match: "S21 một thẻ có link" });
  await tg.send(chat, "S21 một thẻ có link");
  const card = await tg.waitFor(chat, "s21 card", (m) => m.text.includes("echo s21") && buttonsOf(m).length > 0);
  await tg.pressLabel(chat, card, "Deny");
  await until("s21 card answered", async () => (await fx.recordsOf("s21-card"))[0]?.done);
  const withLink = (await tg.sent(chat)).filter((m) => /Open in PPM: /.test(m.text));
  assert.ok(withLink.length > 0, "a card carries an Open in PPM line");
  for (const m of withLink) assert.ok(!buttonsOf(m).some((b) => b.url), "no URL button without a public https address");
  const link = withLink.at(-1).text.match(/Open in PPM: (\S+)/)[1];
  assert.equal(new URL(link).pathname, "/assistant", `the link opens the Assistant (${link})`);
  assert.equal(new URL(link).searchParams.get("session"), `claude/${sessionId}`, "and names its session");
  // The session's latest answer is what the opened chat shows at the bottom.
  const latestOf = async (id) => (await ctx.fx.state()).turns.filter((t) => t.sessionId === id).at(-1);
  const shows = async (dev, id, name) => {
    const latest = await latestOf(id);
    await kit.chatRoot(dev).getByText(`Turn "${latest.label}" done.`).first().waitFor({ timeout: 20000 });
    assert.equal(await dev.page.locator('[class*="@container/assistant"]:visible').count(), 1, `one Assistant on screen (${dev.name})`);
    await kit.shot(dev, name);
  };
  for (const dev of [kit.devices.desktop, kit.devices.phone]) {
    await kit.openLink(dev, link);
    await shows(dev, sessionId, "s21-open-in-ppm-link");
  }
  // The same kind of link again, in a browser where the Assistant is already open (its window
  // restored from the last visit) and on another session: it switches to the session linked.
  if (other) {
    for (const dev of [kit.devices.desktop, kit.devices.phone]) {
      await kit.openLink(dev, `${ctx.web}/assistant?session=${encodeURIComponent(`claude/${other}`)}`);
      await shows(dev, other, "s21-second-link-switches-session");
    }
  }
  ctx.record("s21", "desktop+phone", "no tunnel: Open in PPM is text, never a URL button; /assistant?session=… opens that Assistant session on desktop and phone, and switches an Assistant already open to it", { link });
}
