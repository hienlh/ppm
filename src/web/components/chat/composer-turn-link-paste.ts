/**
 * A paste into the composer that holds turn links: each link the composer has room for becomes a
 * chip, and everything else in the paste — links over the limit included — goes in at the caret
 * the way typed text would.
 */
import { parseTurnLinks, turnKey, type ParsedTurnLink } from "@/lib/turn-link";

/**
 * The text a paste should insert once its turn links are taken as chips, or null when the
 * composer took none of them (the browser then pastes the text as it is). `addLinks` adds the
 * chips and returns the links it had no room for, which stay in the text.
 */
export function pasteWithoutTurnLinks(
  text: string,
  isProject: (name: string) => boolean,
  addLinks: (links: ParsedTurnLink[]) => readonly ParsedTurnLink[],
): string | null {
  const { links } = parseTurnLinks(text, isProject);
  if (!links.length) return null;
  const overflow = new Set(addLinks(links).map(turnKey));
  if (overflow.size === links.length) return null;
  const { rest } = parseTurnLinks(text, isProject, (link) => !overflow.has(turnKey(link)));
  // A paste that was only links (and the whitespace around them) inserts nothing.
  return rest.trim() ? rest : "";
}

/**
 * Put `text` in place of the textarea's selection through the browser's own editing, as typing
 * does: Ctrl+Z takes it back, and the `input` event runs the composer's usual change handling
 * (draft save, pickers, auto-height). False when the browser did not, so the caller writes the
 * value itself. `execCommand` is deprecated but still the only way to edit with undo intact.
 */
export function insertLikeTyping(ta: HTMLTextAreaElement, text: string): boolean {
  if (!text && ta.selectionStart === ta.selectionEnd) return true;
  const before = ta.value;
  try {
    if (document.activeElement !== ta) ta.focus();
    if (typeof document.execCommand !== "function") return false;
    return document.execCommand("insertText", false, text) && ta.value !== before;
  } catch {
    return false;
  }
}
