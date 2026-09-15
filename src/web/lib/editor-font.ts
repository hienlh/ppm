/**
 * The monospace stack every code surface uses.
 *
 * It has to name a font per platform, because a stack that lists only
 * `Menlo, Monaco, Consolas` resolves to *none* of them on Linux and silently
 * falls through to generic `monospace` — whatever `fc-match monospace` happens
 * to return, which is not a coding font and is the difference between looking
 * like an editor and looking like a text box.
 *
 * The values are the terminal's, which already got this right; the Monaco
 * surfaces were the ones left on the three-font stack. Shared from here so the
 * two cannot drift apart again — that drift is what made the editor and the
 * terminal render in different fonts on the same machine.
 */
export const EDITOR_FONT_FAMILY =
  "Consolas, 'Cascadia Mono', Menlo, 'DejaVu Sans Mono', 'Courier New', monospace";
