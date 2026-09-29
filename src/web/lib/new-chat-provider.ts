// Moved to src/shared so the server's /chat/prepare endpoint can resolve a provider with the
// exact same logic. Re-exported here so existing importers keep working unchanged.
export { resolveNewChatProvider } from "../../shared/new-chat-provider.ts";
