import { ProviderRegistry } from "../providers/registry.ts";
import { ClaudeAgentSdkProvider } from "../providers/claude-agent-sdk.ts";
import type { Session, SessionConfig, SessionInfo, ChatEvent } from "../types/chat.ts";

export class ChatService {
  private registry: ProviderRegistry;

  constructor() {
    this.registry = new ProviderRegistry();
    this.registry.register(new ClaudeAgentSdkProvider(), true);
  }

  async createSession(config: SessionConfig, providerId?: string): Promise<Session> {
    const provider = providerId
      ? this.registry.get(providerId)
      : this.registry.getDefault();
    return provider.createSession(config);
  }

  async resumeSession(sessionId: string, providerId?: string): Promise<Session> {
    const provider = providerId
      ? this.registry.get(providerId)
      : this.registry.getDefault();
    return provider.resumeSession(sessionId);
  }

  async listSessions(providerId?: string): Promise<SessionInfo[]> {
    const provider = providerId
      ? this.registry.get(providerId)
      : this.registry.getDefault();
    return provider.listSessions();
  }

  async deleteSession(sessionId: string, providerId?: string): Promise<void> {
    const provider = providerId
      ? this.registry.get(providerId)
      : this.registry.getDefault();
    return provider.deleteSession(sessionId);
  }

  sendMessage(
    sessionId: string,
    message: string,
    providerId?: string,
  ): AsyncIterable<ChatEvent> {
    const provider = providerId
      ? this.registry.get(providerId)
      : this.registry.getDefault();
    return provider.sendMessage(sessionId, message);
  }

  getRegistry(): ProviderRegistry {
    return this.registry;
  }
}

export const chatService = new ChatService();
