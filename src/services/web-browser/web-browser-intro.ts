/**
 * After Settings → Web Browser saves, a "PPM has new features" question that the user just
 * answered there is settled, and every open PPM is told so the step disappears without a reload.
 */
import { settleFeaturesDecidedInSettings } from "../feature-intros.service.ts";
import { broadcastGlobalEvent } from "../../server/ws/global.ts";
import { FEATURE_INTROS_CHANGED_EVENT } from "../../shared/feature-intros.ts";

export function settleWebBrowserIntro(): void {
  try {
    if (settleFeaturesDecidedInSettings()) broadcastGlobalEvent({ type: FEATURE_INTROS_CHANGED_EVENT, change: "settings" });
  } catch {
    // The answer is saved either way; the tour re-reads on its next open.
  }
}
