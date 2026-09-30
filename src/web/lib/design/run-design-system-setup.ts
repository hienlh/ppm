import { toast } from "sonner";
import { buildDesignSystemInitPrompt } from "../../../shared/design-system-init-prompt";
import { ensureShowcaseDesign, getDesignSystem } from "./api-design-systems";
import { openDesignTab } from "./open-design-tab";
import { autoSendToDesignChat, deliverToDesignChat } from "./deliver-to-design-chat";

/** How long a just-opened tab's composer may still be mounting before its first render lands. */
const MOUNT_RETRY_MS = 2000;
const MOUNT_RETRY_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Auto-sends only once a listener actually acks the event (the composer is mounted): a tab
 * just opened by this same call has not rendered yet, and `autoSendToDesignChat` answers
 * "none" — not "chip" — for an address nothing is listening on yet, which would otherwise
 * drop the brief silently rather than degrade to a chip.
 */
async function autoSendOnceMounted(tabId: string, text: string, label: string): Promise<"sent" | "chip"> {
  const deadline = Date.now() + MOUNT_RETRY_MS;
  for (;;) {
    const outcome = autoSendToDesignChat(tabId, text, label);
    if (outcome !== "none") return outcome;
    if (Date.now() >= deadline) break;
    await sleep(MOUNT_RETRY_INTERVAL_MS);
  }
  // Still nothing listening after the deadline: fall back to a prefill the user sends
  // themselves, the same degrade `deliverToDesignChat` already uses elsewhere.
  deliverToDesignChat(tabId, text, label);
  return "chip";
}

/**
 * "Set up design system", from the canvas More menu or the New Design dialog's "Set up
 * first" step: get-or-create the app's showcase design, open its tab, and auto-send the
 * setup brief there — auto-sent because the user just clicked a button asking for exactly
 * this, not typed it themselves. A composer that is mid-turn (or still mounting) gets it as
 * a chip instead, never interrupting a running send or racing the new tab's first render.
 */
export async function runDesignSystemSetup(projectName: string, systemId: string): Promise<void> {
  const [showcase, system] = await Promise.all([
    ensureShowcaseDesign(projectName, systemId),
    getDesignSystem(projectName, systemId),
  ]);
  const tabId = openDesignTab({ projectName, slug: showcase.slug, title: showcase.title });
  const prompt = buildDesignSystemInitPrompt(system);
  if ((await autoSendOnceMounted(tabId, prompt, "Set up design system")) === "chip") {
    toast.info("Setup brief added to the chat", { description: "Review and send it there." });
  }
}
