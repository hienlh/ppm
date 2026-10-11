import { losesWorkOnClose } from "@/stores/tab-close-confirm-store";
import type { Tab } from "@/stores/tab-store";
import { readTabLiveContent } from "./tab-live-content";

/**
 * Why closing `tab` would lose something, or null when it would not. The Assistant closes such
 * a tab only with the user's approval.
 *
 * Where each kind of unsaved work lives:
 *  - database tabs: the same test the close dialog asks (`losesWorkOnClose`: SQL typed in a
 *    Query tab, a table changed on its Structure tab, edited grid rows);
 *  - an editor: its own `unsaved` state, published while it is mounted (`tab-live-content`) —
 *    a named file is saved a second after the last keystroke, or never when that save failed;
 *    an untitled file's text is kept only in the tab's `unsavedContent`, also when unmounted;
 *  - a terminal: closing it ends the shell and whatever runs in it, which no save brings back.
 */
export function unsavedWorkReason(tab: Pick<Tab, "id" | "type" | "metadata">): string | null {
  if (losesWorkOnClose(tab)) {
    return "It holds database work that is not saved: SQL typed in a Query tab, a table changed on its Structure tab, or edited rows.";
  }
  if (tab.type === "editor") {
    const live = readTabLiveContent(tab.id);
    if (live?.kind === "editor" && live.dirty) return "Its editor has changes that are not saved yet.";
    const text = tab.metadata?.unsavedContent;
    if (tab.metadata?.isUntitled === true && typeof text === "string" && text.length > 0) {
      return "It is an untitled file whose text has never been saved.";
    }
  }
  if (tab.type === "terminal") return "Closing a terminal ends its shell and anything still running in it.";
  return null;
}
