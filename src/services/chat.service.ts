import { providerRegistry } from "../providers/registry.ts";
import type {
  Session,
  SessionConfig,
  SessionInfo,
  ChatEvent,
  ChatMessage,
} from "../providers/provider.interface.ts";
import { MockProvider } from "../providers/mock-provider.ts";

class ChatService {
  async createSession(
    providerId?: string,
    config: SessionConfig = {},
  ): Promise<Session> {
    const provider = providerId
      ? providerRegistry.get(providerId)
      : providerRegistry.getDefault();
    if (!provider) throw new Error(`Provider "${providerId}" not found`);
    return provider.createSession(config);
  }

  async resumeSession(
    providerId: string,
    sessionId: string,
  ): Promise<Session> {
    const provider = providerRegistry.get(providerId);
    if (!provider) throw new Error(`Provider "${providerId}" not found`);
    return provider.resumeSession(sessionId);
  }

  async listSessions(providerId?: string): Promise<SessionInfo[]> {
    if (providerId) {
      const provider = providerRegistry.get(providerId);
      if (!provider) throw new Error(`Provider "${providerId}" not found`);
      return provider.listSessions();
    }
    // Aggregate from all providers
    const all: SessionInfo[] = [];
    for (const info of providerRegistry.list()) {
      const provider = providerRegistry.get(info.id);
      if (provider) {
        const sessions = await provider.listSessions();
        all.push(...sessions);
      }
    }
    return all.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async deleteSession(
    providerId: string,
    sessionId: string,
  ): Promise<void> {
    const provider = providerRegistry.get(providerId);
    if (!provider) throw new Error(`Provider "${providerId}" not found`);
    return provider.deleteSession(sessionId);
  }

  async *sendMessage(
    providerId: string,
    sessionId: string,
    message: string,
  ): AsyncIterable<ChatEvent> {
    const provider = providerRegistry.get(providerId);
    if (!provider) {
      yield { type: "error", message: `Provider "${providerId}" not found` };
      return;
    }
    yield* provider.sendMessage(sessionId, message);
  }

  /** Look up a session across all providers (for WS handler) */
  getSession(sessionId: string): Session | null {
    for (const info of providerRegistry.list()) {
      const provider = providerRegistry.get(info.id);
      if (!provider) continue;
      // Check in-memory sessions — providers store them
      const sessions = (provider as any).sessions as Map<string, Session> | undefined;
      if (sessions?.has(sessionId)) {
        return sessions.get(sessionId) ?? null;
      }
    }
    return null;
  }

  getMessages(providerId: string, sessionId: string): ChatMessage[] {
    const provider = providerRegistry.get(providerId);
    if (!provider) return [];
    // Only MockProvider has getMessages for now
    if (provider instanceof MockProvider) {
      return provider.getMessages(sessionId);
    }
    return [];
  }
}

export const chatService = new ChatService();
