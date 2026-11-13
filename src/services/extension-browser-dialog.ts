import { broadcastExtMsg, requestFromBrowser } from "../server/ws/extensions.ts";
import type { ExtServerMsg } from "../types/extension-messages.ts";
import type { ExtensionApiDeps } from "./extension-api/index.ts";

/**
 * How long a quick pick, input box or composer waits for the user. The worker waits exactly as
 * long for the same call (`requestWithTimeout(..., 600_000, ...)` in vscode-compat's
 * window.ts); a shorter wait here answered "cancelled" while the dialog was still open, and
 * the user's answer was then dropped.
 */
export const EXTENSION_DIALOG_TIMEOUT_MS = 600_000;

/**
 * Show a dialog in every connected browser tab and wait for the first answer, for as long as
 * the worker that asked is alive: a rebuild of the extension host ends the wait at once, since
 * nobody is left to read the answer.
 *
 * However the wait ends (an answer, the timeout, or the rebuild), `dismiss` is broadcast so no
 * tab keeps showing a dialog whose answer would go nowhere.
 */
export async function askBrowserDialog<T>(
  show: ExtServerMsg,
  requestId: string,
  dismiss: ExtServerMsg,
  deps: ExtensionApiDeps,
): Promise<T | undefined> {
  const call = deps.beginCall();
  try {
    return await requestFromBrowser<T>(show, requestId, EXTENSION_DIALOG_TIMEOUT_MS, call.signal);
  } finally {
    call.end();
    broadcastExtMsg(dismiss);
  }
}
