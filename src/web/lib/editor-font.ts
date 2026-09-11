/**
 * The fonts every code surface uses.
 *
 * A stack has to name a font per platform, because one that lists only
 * `Menlo, Monaco, Consolas` resolves to *none* of them on Linux and silently
 * falls through to generic `monospace` — whatever `fc-match monospace` happens
 * to return, which is not a coding font and is the difference between looking
 * like an editor and looking like a text box.
 *
 * The first entry of each stack is now bundled rather than hoped for
 * (`main.tsx` imports the faces), so the fallbacks below it are only for a face
 * that fails to load. Monaspace's five families share one set of metrics by
 * design, which is what makes it safe to set ghost text in a different one from
 * the code underneath: Monaco positions everything by column times character
 * width, and a family with a different advance would slide out of the grid.
 */

/**
 * Editor, diff panes and the conflict resolver.
 *
 * `Monaspace Argon Var` sits second on purpose. The bundled face is the Latin
 * subset, and a `@font-face` shadows a system font of the same family name
 * entirely — so on a host where the full Monaspace is installed, a Vietnamese
 * comment would still fall per-glyph to the platform monospace while the right
 * font sat unused. The variable build is installed under its own family name,
 * so naming it separately picks up exactly the glyphs the subset lacks, in the
 * same typeface.
 */
export const EDITOR_FONT_FAMILY =
  "'Monaspace Argon', 'Monaspace Argon Var', Consolas, 'Cascadia Mono', Menlo, 'DejaVu Sans Mono', 'Courier New', monospace";

/**
 * Inline suggestions. A different face at the same metrics says "this is not
 * your code yet" without moving a single character.
 */
export const GHOST_TEXT_FONT_FAMILY =
  "'Monaspace Krypton', 'Monaspace Krypton Var', 'Monaspace Argon', Consolas, 'Cascadia Mono', Menlo, 'DejaVu Sans Mono', monospace";

/**
 * The terminal. MesloLGM Nerd Font first because a shell prompt is full of
 * powerline separators and devicons that only a patched font has — it is not
 * bundled, because the patched faces are over a megabyte each and a terminal
 * has to open on a phone too. Where it is installed it wins; where it is not,
 * Monaspace Argon is bundled and the glyphs fall back per character.
 */
export const TERMINAL_FONT_FAMILY =
  "'MesloLGM Nerd Font', 'MesloLGS Nerd Font', 'Symbols Nerd Font', 'Monaspace Argon', 'Monaspace Argon Var', Consolas, 'Cascadia Mono', Menlo, 'DejaVu Sans Mono', 'Courier New', monospace";

/**
 * Monaspace's ligatures plus every stylistic set, which is where its texture
 * healing lives: `ss01`–`ss09` are what narrow an `i` next to an `m` so a run
 * of `www.mmm.iii` stops looking like a picket fence. Monaco takes this string
 * straight through to `font-feature-settings`.
 */
export const EDITOR_FONT_LIGATURES =
  "'calt', 'liga', 'ss01', 'ss02', 'ss03', 'ss04', 'ss05', 'ss06', 'ss07', 'ss08', 'ss09'";

/** Editor font size. 14 to match the font's own optical size. */
export const EDITOR_FONT_SIZE = 14;
