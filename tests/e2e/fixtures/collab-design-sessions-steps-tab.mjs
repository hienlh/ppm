// The Design chat an ordinary chat opened, seen from the Design tab the user opens it in
// (tests/e2e/collab-design-sessions-e2e.mjs, after D1–D3):
//
//   D4  the sidebar's Designs section lists the design, and the chat list holds the Design chat;
//   D5  opening the design shows the canvas (the variant built) on the left and, on the right, the
//       Design chat with every turn the ordinary chat sent it;
//   D6  a message typed in that Design tab is answered, and the canvas shows the change;
//   D7  the ordinary chat messages the Design chat again, and the open Design tab shows the message
//       and the answer as they happen, with no reload.
//
// Each step takes a desktop screenshot; D4 and D5 also take one on a phone.
import assert from "node:assert/strict";

const RAIL_BUTTON = (page, label) => page.locator("button", { has: page.locator(`span:text-is("${label}")`) }).first();
const CANVAS = 'iframe[title="Design canvas: Kho task"]';
const CHAT_PANE = '[data-design-pane="chat"]';

/** The canvas document shown now, once its body holds `text`. */
async function canvasShowing(kit, page, text, timeout = 30000) {
  return kit.until(`the canvas showing "${text}"`, async () => {
    const frames = await page.locator(`${CANVAS}:visible`).elementHandles();
    for (const handle of frames) {
      const frame = await handle.contentFrame();
      const body = frame ? await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "") : "";
      if (body.includes(text)) return frame;
    }
    return null;
  }, timeout, 250);
}

const chatPaneText = (page) => page.locator(`${CHAT_PANE}:visible`).first().innerText();

/** Opens the design from the sidebar's Designs section on a desktop. */
async function openFromSidebar(page) {
  await RAIL_BUTTON(page, "Designs").click();
  const item = page.locator("button", { hasText: "Kho task" }).filter({ hasNotText: "UI" }).first();
  await item.waitFor({ timeout: 20000 });
  return item;
}

/**
 * Answers Later to the tour's question about a feature this run does not use: it opens a moment
 * after the page and covers part of the screen (all of it on a phone).
 */
async function dismissFeatureIntro(page) {
  const intro = page.getByText("PPM has new features", { exact: false }).first();
  if (await intro.waitFor({ timeout: 15000 }).then(() => true, () => false)) {
    await page.getByText("Later", { exact: true }).first().click();
    await intro.waitFor({ state: "hidden", timeout: 10000 });
  }
}

/** Sends a chat message the way the browser does, on a socket of its own: the open page is left alone. */
async function sendAsChat(page, sessionId, content) {
  await page.evaluate(async ({ sessionId, content }) => {
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/project/alpha/chat/${sessionId}`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.send(JSON.stringify({ type: "message", clientMessageId: `e2e-${Date.now()}`, content }));
    // Kept open until the server has the message; the chat goes on without this socket.
    await new Promise((r) => setTimeout(r, 1500));
    ws.close();
  }, { sessionId, content });
}

export async function runDesignTabSteps(ctx) {
  const { kit, ck, page, browser, web, A } = ctx;
  const child = ctx.child;
  assert.ok(child, "D1 created the Design chat");

  await kit.scenario("D4", async () => {
    await dismissFeatureIntro(page);
    const item = await openFromSidebar(page);
    assert.match(await item.innerText(), /Kho task/);
    await kit.shot(page, "d4-sidebar-design-list");
    await RAIL_BUTTON(page, "Chat History").click();
    const listed = page.locator("text=Kho task UI").first();
    await listed.waitFor({ timeout: 20000 });
    await kit.shot(page, "d4b-sidebar-chat-list");
    kit.record("D4: the Designs section lists Kho task; the chat list holds the Design chat Kho task UI");
  });

  await kit.scenario("D5", async () => {
    const item = await openFromSidebar(page);
    await item.click();
    await page.locator(`${CANVAS}:visible`).waitFor({ timeout: 30000 });
    await canvasShowing(kit, page, "Kho task — Light");
    await kit.until("the Design chat's turns in the chat pane", async () => {
      const text = await chatPaneText(page).catch(() => "");
      return /Build two variants of the Kho task board/.test(text) && /Make variant 2 darker/.test(text)
        && /variant-2\.html: background is now #0b1120/.test(text);
    }, 30000, 300);
    const canvasBox = await page.locator(`${CANVAS}:visible`).boundingBox();
    const chatBox = await page.locator(`${CHAT_PANE}:visible`).first().boundingBox();
    assert.ok(canvasBox && chatBox && canvasBox.x < chatBox.x, "the canvas is on the left, the chat on the right");
    await kit.shot(page, "d5-design-tab-canvas-and-chat");
    kit.record("D5: the Design tab shows the variant on the canvas (left) and the turns the ordinary chat sent (right)");
  });

  await kit.scenario("D6", async () => {
    await ck.plan(child, ck.steps(
      { write: "designs/kho-task/index.html", content: ctx.pageHtml("#2563eb", "Light", 28) },
      { say: "Made the buttons bigger: 28px text, more padding." },
    ));
    const box = page.locator(`${CHAT_PANE} textarea:visible`).first();
    await box.fill("Make the buttons bigger");
    await box.press("Enter");
    await kit.until("the Design chat's answer in the tab", async () => /Made the buttons bigger/.test(await chatPaneText(page)), 30000, 300);
    const frame = await kit.until("the canvas with the bigger button", async () => {
      const f = await canvasShowing(kit, page, "Kho task — Light");
      const size = await f.evaluate(() => getComputedStyle(document.querySelector("button")).fontSize).catch(() => "");
      return size === "28px" ? f : null;
    }, 30000, 300);
    assert.ok(frame);
    await kit.shot(page, "d6-typed-in-design-tab-canvas-updated");
    kit.record("D6: a message typed in the Design tab is answered and the canvas shows the bigger buttons");
  });

  await kit.scenario("D7", async () => {
    await ck.plan(A.id, ck.steps(
      { call: "send_to_session", args: { session_id: child, message: "Add a task count to each column header.", wait: true } },
      { say: "The Design chat added the counts." },
    ));
    await ck.plan(child, ck.steps({ say: "Each column header now shows its task count (Inbox 2, Doing 2, Done 2)." }));
    const loadsBefore = await page.evaluate(() => performance.getEntriesByType("navigation").length + ":" + performance.timeOrigin);
    const from = (await ck.calls()).length;
    // The ordinary chat's turn is started from a second tab; the Design tab stays as it is.
    const other = await page.context().newPage();
    await other.goto(`${web}/api/health`);
    await sendAsChat(other, A.id, "Ask the Design chat to add task counts.");
    await other.close();
    await kit.until("the message in the open Design tab", async () => /Add a task count to each column header/.test(await chatPaneText(page)), 30000, 300);
    await kit.until("the answer in the open Design tab", async () => /Inbox 2, Doing 2, Done 2/.test(await chatPaneText(page)), 30000, 300);
    const [call] = await ck.answered(from, 1, (c) => c.tool === "send_to_session", 60000);
    assert.match(call.text, /Inbox 2, Doing 2, Done 2/);
    const loadsAfter = await page.evaluate(() => performance.getEntriesByType("navigation").length + ":" + performance.timeOrigin);
    assert.equal(loadsAfter, loadsBefore, "the Design tab was not reloaded");
    await kit.shot(page, "d7-live-message-from-ordinary-chat");
    kit.record("D7: the ordinary chat's message and the Design chat's answer appear live in the open Design tab");
  });

  await kit.scenario("D4-D5 phone", async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    await phone.addInitScript(ctx.pageInit);
    const p = await phone.newPage();
    try {
      await p.goto(`${web}/project/alpha`);
      await dismissFeatureIntro(p);
      await p.getByRole("button", { name: "Open menu" }).first().click();
      await p.locator("button:visible", { hasText: "Designs" }).first().click();
      const item = p.locator("button", { hasText: "Kho task" }).filter({ hasNotText: "UI" }).first();
      await item.waitFor({ timeout: 20000 });
      await kit.shot(p, "d4-phone-design-list");
      await item.click();
      const nav = p.getByRole("navigation", { name: "Design view" });
      await nav.waitFor({ timeout: 30000 });
      await canvasShowing(kit, p, "Kho task — Light");
      await kit.shot(p, "d5-phone-canvas");
      await nav.getByRole("button", { name: "Chat" }).click();
      await kit.until("the Design chat on the phone", async () => /Inbox 2, Doing 2, Done 2/.test(await p.locator("body").innerText()), 30000, 300);
      await kit.shot(p, "d5-phone-chat");
      kit.record("D4/D5 on a phone: the design in the Designs list, its canvas, and the Design chat");
    } catch (e) {
      await p.screenshot({ path: `${ctx.artifacts}/FAIL-phone.png` }).catch(() => {});
      throw e;
    } finally {
      await phone.close();
    }
  });
}
