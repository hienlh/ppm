import { assembleBridge, assertInlineScript } from "./bridge-script.ts";
import { installNavGuard } from "./bridge-nav-guard.ts";
import { installPicker } from "./bridge-picker.ts";
import { installPins } from "./bridge-pins.ts";
import { anchorOf, cssPathOf, describeElement, domTreeAccess, elementQuote } from "./bridge-element-info.ts";
import { diceSimilarity, resolveAnchor } from "./bridge-anchor-resolve.ts";
import { createPickerOverlay } from "./bridge-picker-overlay.ts";

/**
 * The bridge a reviewer's view of a shared design gets: the core, the element picker, the
 * comment pins and the navigation guard. Nothing that moves, resizes, tweaks or undoes —
 * those features are what propose a write to the design, and a reviewer's frame has no
 * write to propose. The lib carries exactly the helpers these three features call.
 */
export const GUEST_BRIDGE_JS = assembleBridge([installPicker, installPins, installNavGuard], {
  anchorOf, describeElement, diceSimilarity, resolveAnchor, createPickerOverlay, cssPathOf, elementQuote, domTreeAccess,
});

assertInlineScript(GUEST_BRIDGE_JS, "guest design bridge");
