/**
 * The AI settings subset a sessionless chat tab needs to resolve its provider and permission.
 *
 * Deliberately narrower than the full `AIConfig`/`AISettings` shape: no `api_key`,
 * `api_key_env`, `system_prompt`, or any other field a client should never see. Both the
 * server's `/chat/prepare` response and the browser's own preparation cache build this same
 * subset from their respective full settings objects, so it has to live where neither of them
 * owns it — `src/shared` is imported by both without pulling web-only or server-only types
 * along with it.
 */
export interface ChatPreparationProviderSettings {
  permission_mode?: string;
}

export interface ChatPreparationSettings {
  default_provider: string;
  new_chat_provider_mode?: "default" | "follow-focus";
  providers: Record<string, ChatPreparationProviderSettings>;
}
