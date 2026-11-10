// The Assistant's session list, as both Assistant e2e suites reach it. It lives in Settings →
// PPM Assistant → Sessions & Telegram, opened from the gear the Assistant carries (its window's
// titlebar on a desktop, its own head on a phone): a floating window on a desktop, a tab on a phone.

const SECTION = '[data-testid="assistant-sessions-section"]:visible';
const SETTINGS_WINDOW = '[aria-roledescription="window"][aria-label="Settings"]:visible';

/** Opens the list (or finds it already open) and returns the section holding it. */
export async function openAssistantSessionList(page) {
  const section = page.locator(SECTION).first();
  if (!(await section.count())) {
    await page.locator('button[aria-label="PPM Assistant settings"]:visible').first().click();
    await page.locator('[data-testid="assistant-settings-tab-sessions"]:visible').first().click();
  }
  await section.waitFor({ timeout: 15000 });
  return section;
}

/** The row of the session titled `title`; a tap on it opens that session in the Assistant. */
export const assistantSessionRow = (list, title) =>
  list.locator('ul[aria-label="Assistant sessions"] button:visible', { hasText: title }).first();

/**
 * Closes the Settings window on a desktop, so a later reload does not restore it over the
 * Assistant. Dispatched rather than clicked: opening a session brings the Assistant's window to
 * the front, and it may cover the close button. A phone's Settings tab needs nothing: the
 * Assistant takes the screen back when a session is opened or the tab switcher is used.
 */
export async function closeAssistantSessionList(page) {
  const win = page.locator(SETTINGS_WINDOW);
  if (await win.count()) await win.first().locator('button[aria-label="Close window"]').first().dispatchEvent("click");
}
