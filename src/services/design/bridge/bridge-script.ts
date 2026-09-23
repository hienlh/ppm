import { installBridgeCore, type BridgeApi, type BridgeLib } from "./bridge-core.ts";
import { installNavGuard } from "./bridge-nav-guard.ts";
import { installPicker } from "./bridge-picker.ts";
import { installPins } from "./bridge-pins.ts";
import { installTweaks } from "./bridge-tweaks.ts";
import { anchorOf, cssPathOf, describeElement, domTreeAccess, elementQuote } from "./bridge-element-info.ts";
import { diceSimilarity, resolveAnchor } from "./bridge-anchor-resolve.ts";
import { createPickerOverlay } from "./bridge-picker-overlay.ts";

/**
 * The bridge script injected as the first child of a design document's `<head>`.
 *
 * Each feature is a real, typed, tested function shipped as its own source through
 * `toString()` (Bun hands back the type-stripped JavaScript), rather than a second copy
 * kept inside a template literal. Features are called through an array, never by name, so
 * a bundler renaming a function cannot break the assembly; each one receives everything
 * it needs in `ppm`. Later features append themselves to {@link BRIDGE_FEATURES}.
 *
 * Shared helpers travel the same way as {@link BRIDGE_LIB}, installed as `ppm.lib` under
 * the string keys written here, before any feature runs.
 */

export type BridgeFeature = (ppm: BridgeApi) => void;

export const BRIDGE_LIB: BridgeLib = {
  elementQuote, domTreeAccess, cssPathOf, anchorOf, describeElement, diceSimilarity, resolveAnchor, createPickerOverlay,
};

export const BRIDGE_FEATURES: readonly BridgeFeature[] = [
  // Ahead of the nav guard: while picking, a click on a link selects it and must not also
  // be reported as a blocked navigation.
  installPicker,
  installPins,
  installNavGuard,
  installTweaks,
];

export function assembleBridge(features: readonly BridgeFeature[], lib: Partial<BridgeLib> = BRIDGE_LIB): string {
  const list = features.map((feature) => `(${feature.toString()})`).join(",\n");
  const helpers = Object.entries(lib)
    .map(([name, fn]) => `${JSON.stringify(name)}: (${(fn as () => void).toString()})`)
    .join(",\n");
  return `(function (window) {
"use strict";
var ppm = (${installBridgeCore.toString()})(window);
var lib = {${helpers}};
for (var name in lib) ppm.lib[name] = lib[name];
var features = [${list}];
for (var i = 0; i < features.length; i++) {
  try { features[i](ppm); } catch (e) { ppm.issue("error", "bridge feature failed: " + (e && e.message)); }
}
ppm.start();
})(window);`;
}

export const BRIDGE_JS = assembleBridge(BRIDGE_FEATURES);

// Inside a <script> element the HTML tokenizer ends the element at the first `</script`,
// and `<!--` / `<script` switch it into escaped states. Fail at startup, not in a browser.
if (/<\/script|<!--|<script/i.test(BRIDGE_JS)) {
  throw new Error("The design bridge contains a sequence that would break out of its <script> element");
}

const escapeAttr = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface BridgeTagInput {
  nonce: string | null;
  gen: string;
  cssGens: Record<string, string>;
  /** The HTML file's path relative to the design folder. */
  file: string;
  instrumented: boolean;
}

/**
 * The `<script>` element. Per-load values travel as attributes the core reads and removes,
 * so the script body is one constant and nothing request-derived is ever inside it.
 */
export function bridgeTag(input: BridgeTagInput): string {
  return `<script data-ppm-bridge="1" data-nonce="${escapeAttr(input.nonce ?? "")}" data-gen="${escapeAttr(input.gen)}"`
    + ` data-css-gens="${escapeAttr(JSON.stringify(input.cssGens))}" data-file="${escapeAttr(input.file)}"`
    + ` data-instrumented="${input.instrumented ? "1" : "0"}">${BRIDGE_JS}</script>`;
}
