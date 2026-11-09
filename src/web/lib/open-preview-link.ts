/**
 * Opening a link clicked inside an HTML file preview, whose sandbox cannot open anything
 * itself. A PPM address becomes a PPM tab; anything else on the web opens in a browser tab,
 * since most sites (GitHub, Jira) refuse to be framed and would show a blank PPM tab.
 *
 * Only a link the person just clicked is opened — `navigator.userActivation` carries a click
 * inside the frame up to this window — so a page cannot open tabs by itself.
 */
import { ppmUrlState, showProjectTab } from "./open-ppm-tab";

/** Whether the link was taken; false when it was refused or is not a web address. */
export function openPreviewLink(href: string): boolean {
  if (navigator.userActivation && !navigator.userActivation.isActive) return false;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const state = ppmUrlState(url.href);
  if (state?.projectName) {
    void showProjectTab(state.projectName, state.tabType, state.tabIdentifier);
    return true;
  }
  window.open(url.href, "_blank", "noopener,noreferrer");
  return true;
}
