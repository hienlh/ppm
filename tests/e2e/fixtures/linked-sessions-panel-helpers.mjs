/**
 * The linked sessions live in the Sessions tab of the chat footer's activity chip — a popover on a
 * desktop, a bottom sheet on a phone — rather than in a bar that is always on screen. These open
 * that tab when it is not already showing and hand back what the e2e flows look at.
 */

/** Opens the activity chip's Sessions tab on the page's visible chat, unless it is already open. */
export async function openLinkedSessions(page, { timeout = 15000 } = {}) {
  const panel = page.locator("[data-linked-sessions-panel]:visible").first();
  if (await panel.count()) return panel;
  const chip = page.locator("[data-activity-chip]:visible").first();
  await chip.waitFor({ timeout });
  await chip.click();
  const tab = page.locator('[data-activity-tab="sessions"]:visible').first();
  await tab.waitFor({ timeout: 5000 });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await panel.waitFor({ timeout: 5000 });
  return panel;
}

/** One linked session's row in the Sessions tab, opening the tab first. */
export async function linkedSessionRow(page, sessionId, opts) {
  const panel = await openLinkedSessions(page, opts);
  return panel.locator(`[data-linked-session="${sessionId}"]`).first();
}

/** A linked session's live status, read from its row (the tab is opened if needed). */
export async function linkedSessionStatus(page, sessionId) {
  const row = await linkedSessionRow(page, sessionId);
  if (!(await row.count())) return null;
  return row.getAttribute("data-linked-status");
}

/** Closes the popover (Escape) or the phone's sheet (its backdrop), if one is open. */
export async function closeLinkedSessions(page) {
  if (!(await page.locator("[data-linked-sessions-panel]:visible").count())) return;
  const vp = page.viewportSize();
  if (vp && vp.width < 768) await page.mouse.click(vp.width / 2, 105);
  else await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
}
