/**
 * Picks what to focus inside a freshly opened PiP window.
 *
 * Moving a subtree into another document does not move focus with it, so a popped-out
 * terminal or editor would sit there swallowing nothing until the user clicked it. The
 * order below is "the thing you type into first": xterm's hidden helper textarea, Monaco's
 * edit context or textarea, then any other text surface, and only then the first focusable
 * control.
 *
 * A panel slot can hold several tabs (the inactive ones are `display: none`), so hidden
 * candidates are skipped — focusing one of those steals input from the visible tab.
 */

/** The subset of an element this module touches; keeps the helper testable without a DOM. */
export interface FocusCandidate {
  focus(): void;
  checkVisibility?(): boolean;
  readonly offsetParent?: unknown;
}

/** Text surfaces first, in the order a user would expect to type into them. */
export const PIP_FOCUS_SELECTORS = [
  ".xterm-helper-textarea",
  ".native-edit-context",
  "textarea",
  "[contenteditable]",
  'button, [href], input, select, [tabindex]:not([tabindex="-1"])',
];

function isVisible(el: FocusCandidate): boolean {
  // checkVisibility() is the accurate answer (display, content-visibility, hidden
  // attribute) and exists wherever Document PiP does; offsetParent is the fallback
  // for a test double or an older engine.
  if (typeof el.checkVisibility === "function") return el.checkVisibility();
  return el.offsetParent !== null && el.offsetParent !== undefined;
}

/**
 * First visible match for the selector list, or null.
 *
 * Takes a query function rather than a root node so the caller keeps its own element type
 * (`doc.querySelectorAll<HTMLElement>`) and a test can pass a plain fake.
 */
export function pipFocusTarget<T extends FocusCandidate>(
  query: (selector: string) => Iterable<T>,
): T | null {
  for (const selector of PIP_FOCUS_SELECTORS) {
    for (const el of query(selector)) {
      if (isVisible(el)) return el;
    }
  }
  return null;
}

/** Focus the popped-out tab's primary input so the user can type straight away. */
export function focusPipDocument(doc: Document): void {
  pipFocusTarget<HTMLElement>((selector) => doc.querySelectorAll<HTMLElement>(selector))?.focus();
}
