import { SEND_TO_CHAT_ACK_EVENT, SEND_TO_CHAT_EVENT, type SendToChatAck, type SendToChatDetail } from "@/lib/send-to-chat";
import { patchTabMetadata } from "@/lib/patch-tab-metadata";

/**
 * Put text into ONE design tab's composer, for the user to review and send. Nothing the
 * user asked for is ever sent on their behalf; the only message PPM sends by itself is the
 * canvas self-check's report ({@link autoSendToDesignChat}).
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

/**
 * PPM's own follow-up after a turn (the canvas self-check): sent straight into the design
 * chat when its composer is idle and empty, so it lands in the transcript like any message;
 * a chip beside whatever the user is typing otherwise, since their draft is theirs to send.
 * `none` means no composer is mounted, and nothing was delivered.
 */
export function autoSendToDesignChat(tabId: string, text: string, label: string): "sent" | "chip" | "none" {
  if (!tabId || !text.trim()) return "none";
  let outcome: "sent" | "chip" | "none" = "none";
  const onAck = (e: Event) => { outcome = (e as CustomEvent<SendToChatAck>).detail?.sent ? "sent" : "chip"; };
  window.addEventListener(SEND_TO_CHAT_ACK_EVENT, onAck);
  try {
    window.dispatchEvent(new CustomEvent<SendToChatDetail>(SEND_TO_CHAT_EVENT, {
      detail: { text, label, targetTabId: tabId, autoSend: true },
    }));
  } finally {
    window.removeEventListener(SEND_TO_CHAT_ACK_EVENT, onAck);
  }
  return outcome;
}

export function showDesignChat(tabId: string): void {
  window.dispatchEvent(new CustomEvent<DesignShowChatDetail>(DESIGN_SHOW_CHAT_EVENT, { detail: { tabId } }));
}
