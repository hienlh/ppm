/**
 * `/?openSettings=<category>`: the address the PPM Assistant gives for a setting it may not change
 * (a token, a password) and that its Telegram cards open. It lands on that Settings pane, nothing
 * more: the page is PPM's own, behind PPM's sign-in. `assistant:<sub-tab>` also picks the PPM
 * Assistant pane's sub-tab (`assistant:changes` for the settings the Assistant changed).
 *
 * The value is untrusted (anyone can write a link), so it is only ever narrowed to a known pane by
 * `resolveSettingsLink`; anything else opens nothing.
 */
export const SETTINGS_LINK_PARAM = "openSettings";

export interface SettingsDeepLink {
  category: string;
  /** For the PPM Assistant pane: which sub-tab. */
  assistantTab: string | null;
}

const VALUE = /^[a-z][a-z-]{0,39}(?::[a-z][a-z-]{0,39})?$/;

export function settingsLinkFromSearch(search: string): SettingsDeepLink | null {
  const raw = new URLSearchParams(search).get(SETTINGS_LINK_PARAM);
  if (raw === null || !VALUE.test(raw)) return null;
  const [category, tab] = raw.split(":");
  return { category: category!, assistantTab: category === "assistant" && tab ? tab : null };
}

/** The current address without `openSettings`, so a reload does not open the pane again. */
export function addressWithoutSettingsLink(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(SETTINGS_LINK_PARAM);
  return url.pathname + url.search + url.hash;
}
