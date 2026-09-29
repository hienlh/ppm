import type { ChatPreparationSettings } from "./chat-preparation-settings.ts";

/** The source is captured when the tab opens, before another panel can gain focus. */
export function resolveNewChatProvider(settings: ChatPreparationSettings, focusedProvider?: string): string {
  return settings.new_chat_provider_mode === "follow-focus" && focusedProvider && focusedProvider !== "default"
    ? focusedProvider
    : settings.default_provider || "claude";
}
