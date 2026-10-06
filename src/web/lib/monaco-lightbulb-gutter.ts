import type * as Monaco from "monaco-editor";

/** Marks an editor whose glyph margin is held at two lanes; globals.css centres the bulb there. */
export const LIGHTBULB_GUTTER_CLASS = "ppm-lightbulb-gutter";

/**
 * Makes room for Monaco's gutter lightbulb to sit centred before the line numbers.
 *
 * Monaco sizes the glyph margin at one line height per glyph lane in use, and the bulb is the
 * only glyph this editor draws, so the margin is a single 19px lane and the bulb fills it flush
 * against the editor's left edge. Drawing it further right is not enough on its own: Monaco
 * hit-tests the gutter by x alone, so over the line-number column the bulb still opens its menu
 * but the same click also selects that whole line, replacing the selection the menu was opened
 * for. Two empty widgets hold a second lane open instead, so the margin is two lanes on every
 * line and the bulb can sit in the middle of it. One line is enough to hold them: the margin is
 * as wide as the line that uses the most lanes.
 */
export function reserveLightbulbGutter(editor: Monaco.editor.ICodeEditor, monaco: typeof Monaco) {
  editor.updateOptions({ extraEditorClassName: LIGHTBULB_GUTTER_CLASS });
  for (const lane of [monaco.editor.GlyphMarginLane.Left, monaco.editor.GlyphMarginLane.Right]) {
    const node = document.createElement("div");
    // The centred bulb reaches into the right lane, so on line 1 this sits over it.
    node.style.pointerEvents = "none";
    editor.addGlyphMarginWidget({
      getId: () => `${LIGHTBULB_GUTTER_CLASS}.${lane}`,
      getDomNode: () => node,
      // Below the bulb's 0: Monaco draws one glyph per lane and line, the highest first, and
      // the bulb shares the left lane with this widget whenever it is on line 1.
      getPosition: () => ({ lane, zIndex: -1, range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } }),
    });
  }
}
