import { assembleBridge, assertInlineScript, bridgeTag } from "./bridge-script.ts";
import { installLayoutCheck } from "./bridge-layout-check.ts";
import { checkLabel, gridImplicitFindings } from "./bridge-layout-grid.ts";
import { boxFindings } from "./bridge-layout-boxes.ts";
import { captureScreenshot } from "./bridge-layout-screenshot.ts";

/**
 * The bridge an HTML file preview gets: the design bridge's core (script errors, failed
 * loads and CSP violations reported to the parent, then `ready`) and the self-check that
 * measures the page and draws a screenshot. Nothing that selects, edits or blocks links:
 * the preview shows a file as it is, and the self-check is what lets the AI's
 * `open_preview` tool report how the page rendered.
 */
export const HTML_PREVIEW_BRIDGE_JS = assembleBridge([installLayoutCheck], {
  checkLabel, gridImplicitFindings, boxFindings, captureScreenshot,
});

assertInlineScript(HTML_PREVIEW_BRIDGE_JS, "HTML preview bridge");

/** `file` is the page's path below the preview's root directory. */
export function htmlPreviewBridgeTag(input: { nonce: string | null; gen: string; file: string }): string {
  return bridgeTag({ ...input, cssGens: {}, instrumented: false }, HTML_PREVIEW_BRIDGE_JS);
}
