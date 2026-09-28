import type { AISettings } from "./api-settings";

/** The source is captured when the tab opens, before another panel can gain focus. */
export function resolveNewChatProvider(settings: AISettings, focusedProvider?: string): string {
  return settings.new_chat_provider_mode === "follow-focus" && focusedProvider
    ? focusedProvider
    : settings.default_provider || "claude";
}
