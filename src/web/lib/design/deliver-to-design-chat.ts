import { SEND_TO_CHAT_ACK_EVENT, SEND_TO_CHAT_EVENT, type SendToChatDetail } from "@/lib/send-to-chat";
import { patchTabMetadata } from "@/lib/patch-tab-metadata";

/**
 * Put text into ONE design tab's composer, for the user to review and send. Nothing is
 * ever sent on the user's behalf.
 *
 * The composer answers an addressed "send to chat" event with an attachment chip; the
 * event carries the design tab's own id because its embedded chat composer is keyed by it.
 * A composer that is not mounted yet (the chat is still resolving its provider) gets the
 * text as `pendingMessage` instead, which it shows as the input's prefill on mount.
 *
 * `DESIGN_SHOW_CHAT_EVENT` asks the tab to bring its chat into view, which on a phone means
 * switching from the canvas to the chat pane.
 */

export const DESIGN_SHOW_CHAT_EVENT = "ppm:design-show-chat";

export interface DesignShowChatDetail {
  tabId: string;
}

export function deliverToDesignChat(tabId: string, text: string, label: string): void {
  if (!tabId || !text.trim()) return;
  let handled = false;
  const onAck = () => { handled = true; };
  window.addEventListener(SEND_TO_CHAT_ACK_EVENT, onAck);
  try {
    window.dispatchEvent(new CustomEvent<SendToChatDetail>(SEND_TO_CHAT_EVENT, {
      detail: { text, label, targetTabId: tabId },
    }));
  } finally {
    window.removeEventListener(SEND_TO_CHAT_ACK_EVENT, onAck);
  }
  if (!handled) patchTabMetadata(tabId, { pendingMessage: text });
  showDesignChat(tabId);
}

export function showDesignChat(tabId: string): void {
  window.dispatchEvent(new CustomEvent<DesignShowChatDetail>(DESIGN_SHOW_CHAT_EVENT, { detail: { tabId } }));
}
