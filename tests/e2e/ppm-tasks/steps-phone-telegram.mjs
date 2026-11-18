// Phone and Telegram steps of tests/e2e/ppm-tasks-e2e.mjs: the list, long-press sheet and detail at
// 390 × 844 (44 px controls, and the chip row's 26 px where the user picked it), the manager chat's Tasks chip at 390 and 320, and what
// Telegram's `/tasks` sends, pressed through the fake Bot API and drawn as a phone screen.
import assert from "node:assert/strict";
import { until } from "./tasks-kit.mjs";
import { buttonsOf } from "../assistant-telegram/harness.mjs";

/**
 * Buttons in `sel` drawn smaller than 44 px (a hit area widened by an absolute ::after counts). A
 * task's code (`#12` beside a title) is not held to 44 px: it is text in its title's line, and
 * steps-task-codes.mjs checks it at that size (one line tall, never padded) at 1440 and 390.
 */
function smallTargets(page, sel, except = "") {
  return page.evaluate(({ s, except }) => [...document.querySelectorAll(`${s} button, ${s} [role=button]`)].filter((b) => {
    // The task sheet's ×, ··· and Full screen follow the chat footer's row (22 / 26 px, no 44 px
    // minimum): steps-task-window.mjs measures them. So do the snooze controls: steps-snooze.mjs.
    if (b.tabIndex < 0 || (except && b.matches(except)) || b.hasAttribute("data-task-code") || b.matches("[data-task-sheet-close], [data-task-sheet-full-screen], [data-task-open-sheet] [data-task-actions], [data-task-snooze-button], [data-task-unsnooze], [data-task-snoozed-toggle]")) return false;
    const r = b.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const after = getComputedStyle(b, "::after");
    const extra = after.content !== "none" && after.position === "absolute" ? -2 * parseFloat(after.top || "0") : 0;
    return r.height + extra < 43.5 || r.width < 43.5;
  }).map((b) => `${(b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 28)} ${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`), { s: sel, except });
}

/**
 * Controls matching `sel` drawn off the chip row's phone size (docs/design-guidelines.md rule 3):
 * shorter than 26 px, or still at the old 44 px. Content-sized ones may be taller than 26.
 */
function offStandard(page, sel) {
  return page.evaluate((s) => [...document.querySelectorAll(s)].filter((b) => {
    const r = b.getBoundingClientRect();
    return r.width && r.height && (r.height < 25.5 || r.height >= 43.5);
  }).map((b) => `${(b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 28)} ${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`), sel);
}

/** The Tasks list's filter chips (the user's pick): their pills and the buttons inside them. */
const FILTER_CHIPS = ".rounded-full.border:not([data-task-row] *) button, button.rounded-full.border:not([data-task-row] *)";
const FILTER_PILLS = "[data-tasks-panel] span.rounded-full.border:not([data-task-row] *)";
/** The detail's controls the user picked: the cards' buttons (not their list rows) and the footer's. */
const DETAIL_PICKED = "[data-task-card] button:not([data-session-tone]), [data-working-session] button, [data-task-detail-mobile] footer button";

/** The context row's chips cut by its clip, per visible row. */
function rowFit(page) {
  return page.evaluate(() => [...document.querySelectorAll("[data-chat-context-row]")].filter((r) => r.getBoundingClientRect().width > 0).map((row) => {
    const clip = row.firstElementChild.getBoundingClientRect();
    const chips = [...row.firstElementChild.children].filter((c) => c.getAttribute("role") !== "dialog" && c.getBoundingClientRect().width > 0 && getComputedStyle(c).display !== "none");
    return {
      chips: chips.map((c) => (c.getAttribute("aria-label") || c.textContent || "").slice(0, 30)),
      cut: chips.filter((c) => c.getBoundingClientRect().right > clip.right + 0.5).map((c) => c.getAttribute("aria-label") || c.textContent),
      overflow: row.scrollWidth > row.clientWidth + 1,
    };
  }));
}

const openDrawerTasks = (page) => page.evaluate(() => window.dispatchEvent(new CustomEvent("ppm:open-navigation", { detail: { tab: "tasks" } })));

/** Scenario 8 (scene 8): list → long-press sheet → status → detail with Details / Activity. */
async function phoneViews(k, s) {
  const page = await k.openPhone();
  await openDrawerTasks(page);
  const list = page.locator("[data-task-list-mobile]:visible");
  await list.waitFor({ timeout: 30000 });
  await k.scene("s8", "On a phone", "The same list in the drawer; long-press a task for its statuses in a bottom sheet; the detail has Details and Activity.");
  assert.deepEqual(await smallTargets(page, "[data-tasks-panel]", FILTER_CHIPS), [], "every control in the list but the filter chips is at least 44 px");
  assert.deepEqual(await offStandard(page, FILTER_PILLS), [], "the filter chips are the chip row's 26 px");
  await k.beat(1500);
  await k.shot("08-phone-list-390");
  const row = page.locator("[data-task-row]", { hasText: s.t.reply.title }).first();
  await row.dispatchEvent("contextmenu");
  const sheet = page.locator("[data-task-action-sheet]");
  await sheet.waitFor({ timeout: 10000 });
  assert.deepEqual(await offStandard(page, "[data-task-action-sheet] button"), [], "the sheet's statuses and rows are at least the chip row's 26 px, no longer 44-48");
  const names = await sheet.locator("[data-status-id]").allInnerTexts();
  for (const n of ["To do", "In progress", "Waiting", "Done"]) assert(names.some((x) => x.includes(n)), `the sheet lists ${n}: ${names}`);
  await k.beat(1500);
  await k.shot("08-phone-sheet-390");
  await sheet.locator("[data-status-id]").filter({ hasText: "In progress" }).first().tap();
  await until("the status changed", async () => (await k.task(s.t.reply.id)).statusName === "In progress");
  const prompt = page.locator("[data-task-manager-prompt]");
  if (await prompt.first().waitFor({ timeout: 6000 }).then(() => true, () => false)) {
    await k.beat(1200);
    await prompt.getByRole("button", { name: "Next turn" }).first().tap();
  }
  await row.locator("text=In progress").first().waitFor({ timeout: 10000 }).catch(() => {});
  await k.beat(800);
  if (!(await list.count())) await openDrawerTasks(page);
  await page.locator("[data-task-row]").getByText(s.t.login.title).first().tap();
  // The task opens in a bottom sheet over the list.
  const detail = page.locator("[data-task-open-sheet] [data-task-detail-mobile]:visible");
  await detail.waitFor({ timeout: 15000 });
  assert.deepEqual(await smallTargets(page, "[data-task-detail-mobile]", DETAIL_PICKED), [], "every control in the detail but the cards' and footer's buttons is at least 44 px");
  assert.deepEqual(await offStandard(page, DETAIL_PICKED.split(", ").map((x) => (x.startsWith("[data-task-detail-mobile]") ? x : `[data-task-detail-mobile] ${x}`)).join(", ")), [], "the cards' and footer's buttons are at least the chip row's 26 px, no longer 44");
  await k.beat(1500);
  await k.shot("08-phone-detail-390");
  await page.getByRole("tab", { name: /^Activity/ }).tap();
  await k.beat(1800);
  await k.endScene();
  k.record("8", "phone list, long-press sheet with the project's statuses, status change, detail Details/Activity; 44 px except the user's picks, which are the chip row's 26 px");
}

/** Scenario 9 phone: the manager chat's Tasks chip is whole at 390 and 320, and opens a bottom sheet. */
async function phoneChip(k, s) {
  const page = k.page;
  await page.goto(`${k.web}/project/alpha/chat/claude/${s.managers.alpha}`);
  const chip = page.locator("[data-manager-tasks-chip]:visible").first();
  await chip.waitFor({ timeout: 30000 });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 844 });
    await k.beat(400);
    const fit = await rowFit(page);
    assert(fit.length > 0, "a context row is shown");
    for (const r of fit) {
      assert.deepEqual(r.cut, [], `nothing cut at ${width}: ${JSON.stringify(r)}`);
      assert(r.chips.some((c) => /^Tasks:/.test(c)), `the Tasks chip is in the row at ${width}: ${r.chips}`);
    }
  }
  await chip.tap();
  await page.locator("[data-chip-task]:visible").first().waitFor({ timeout: 15000 });
  await k.shot("09-phone-chip-sheet-320");
  await page.setViewportSize({ width: 390, height: 844 });
  k.record("9b", "manager Tasks chip whole at 390 and 320 (nothing cut), opens the bottom sheet");
}

/** Escapes text for the drawn Telegram screen. */
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A Telegram chat screen drawn from what the fake Bot API holds: bubbles with their buttons. */
export function telegramFrame(messages, title) {
  const bubbles = messages.map((m) => {
    const rows = (m.reply_markup?.inline_keyboard ?? []).map((row) => `<div class="row">${row.map((b) => `<span class="btn">${esc(b.text)}</span>`).join("")}</div>`).join("");
    const cls = m.from_user ? "me" : "bot";
    const label = m.caption ? `<div class="cap">${esc(m.caption)}</div>` : "";
    return `${label}<div class="msg ${cls}"><div class="text">${m.html ?? esc(m.text)}</div>${rows ? `<div class="kb">${rows}</div>` : ""}</div>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0e1621;font:15px/1.4 "Liberation Sans",Arial,sans-serif;color:#e9edef;display:flex;justify-content:center}
    .phone{width:430px;min-height:100vh;background:#0e1621;border-left:1px solid #1f2c3a;border-right:1px solid #1f2c3a}
    .bar{position:sticky;top:0;background:#17212b;padding:14px 16px;font-weight:600}
    .bar small{display:block;font-weight:400;color:#7f91a4;font-size:12px}
    .list{padding:12px;display:flex;flex-direction:column;gap:10px}
    .msg{max-width:88%;border-radius:12px;padding:8px 11px;white-space:pre-wrap;word-wrap:break-word}
    .bot{background:#182533;align-self:flex-start}.me{background:#2b5278;align-self:flex-end}
    .kb{margin-top:8px;display:flex;flex-direction:column;gap:4px}.row{display:flex;gap:4px}
    .cap{align-self:center;color:#7f91a4;font-size:12px;margin-top:6px}.btn{flex:1;text-align:center;background:#2b3a4a;border-radius:8px;padding:7px 4px;font-size:13px}
  </style><div class="phone"><div class="bar">${esc(title)}<small>Telegram · drawn from the fake Bot API</small></div><div class="list">${bubbles}</div></div>`;
}

/** Telegram `/tasks` (scene 9): the deck, a status press, "Tell manager now?" — no AI turn. */
async function telegramTasks(k, s) {
  const { tg, owner } = k;
  const turnsBefore = (await k.fx.state()).turns.length;
  const sentBefore = (await tg.sent(owner)).length;
  await tg.send(owner, "/tasks");
  const deck = await tg.waitFor(owner, "the /tasks deck", (m) => /\d+ of \d+ · What to do first/.test(m.text), 30000);
  const first = deck.text;
  // A status press on the first card writes the task as the user, via Telegram.
  const statusButton = buttonsOf(deck).find((b) => /In progress|Waiting|To do/.test(b.text));
  assert(statusButton, `the card has status buttons: ${buttonsOf(deck).map((b) => b.text)}`);
  await tg.press(owner, deck.message_id, statusButton.callback_data);
  const asked = await tg.waitFor(owner, "Tell manager now?", (m) => buttonsOf(m).some((b) => /Tell manager now/.test(b.text)), 20000).catch(() => null);
  if (asked) {
    const next = buttonsOf(asked).find((b) => /Next turn/.test(b.text));
    await tg.press(owner, asked.message_id, next.callback_data);
  }
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal((await k.fx.state()).turns.length, turnsBefore, "/tasks and its buttons cost no AI turn");
  // The deck edits one message in place: draw it as it stood at each step, as the phone showed it.
  const finalCard = (await tg.sent(owner)).slice(sentBefore).findLast((m) => m.message_id === deck.message_id) ?? deck;
  const shown = [
    { text: "/tasks", from_user: true },
    { ...deck, caption: "The first card" },
    ...(asked ? [{ text: "Tap a status", from_user: true }, { ...asked, caption: "After the tap" }] : []),
    ...(asked ? [{ text: "Next turn", from_user: true }] : []),
    { ...finalCard, caption: "The result" },
  ];
  const page = await k.openFrame(telegramFrame(shown, "PPM Assistant"));
  await k.scene("s9", "Telegram: /tasks", "The same “what to do first” list on Telegram, one card at a time, with each project's own status buttons — no AI turn spent.");
  await k.beat(4000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await k.beat(2500);
  await k.shot("10-telegram-tasks");
  await k.endScene();
  k.record("tg", "Telegram /tasks deck with status buttons; a press writes the task and asks Tell manager now / Next turn; no AI turn", { firstCard: first.split("\n")[0] });
}

export const PHONE_STEPS = [
  { id: "phone-views", run: phoneViews },
  { id: "phone-chip", run: phoneChip },
  { id: "telegram-tasks", run: telegramTasks },
];
