import { providerRegistry } from "../providers/registry.ts";
import type {
  Session,
  SessionConfig,
  SessionInfo,
  ChatEvent,
  ChatMessage,
  SendMessageOpts,
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

  async listSessions(providerId?: string, dir?: string): Promise<SessionInfo[]> {
    if (providerId) {
      const provider = providerRegistry.get(providerId);
      if (!provider) throw new Error(`Provider "${providerId}" not found`);
      // Pass dir to providers that support it (SDK provider)
      if (dir && "listSessionsByDir" in provider) {
        return (provider as any).listSessionsByDir(dir);
      }
      return provider.listSessions();
    }
    // Aggregate from all providers
    const all: SessionInfo[] = [];
    for (const info of providerRegistry.list()) {
      const provider = providerRegistry.get(info.id);
      if (provider) {
        if (dir && "listSessionsByDir" in provider) {
          all.push(...await (provider as any).listSessionsByDir(dir));
        } else {
          all.push(...await provider.listSessions());
        }
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
    opts?: SendMessageOpts,
  ): AsyncIterable<ChatEvent> {
    const provider = providerRegistry.get(providerId);
    if (!provider) {
      yield { type: "error", message: `Provider "${providerId}" not found` };
      return;
    }
    yield* provider.sendMessage(sessionId, message, opts);
  }

  /** Look up a session across all providers (for WS handler) */
  getSession(sessionId: string): Session | null {
    for (const info of providerRegistry.list()) {
      const provider = providerRegistry.get(info.id);
      if (!provider) continue;
      const sessions = (provider as any).sessions as Map<string, unknown> | undefined;
      if (sessions?.has(sessionId)) {
        const entry = sessions.get(sessionId);
        // SDK provider stores {meta, sdk}, others store Session directly
        if (entry && typeof entry === "object" && "meta" in entry) {
          return (entry as { meta: Session }).meta;
        }
        return entry as Session ?? null;
      }
    }
    return null;
  }

  async getMessages(providerId: string, sessionId: string): Promise<ChatMessage[]> {
    const provider = providerRegistry.get(providerId);
    if (!provider) return [];
    if ("getMessages" in provider && typeof (provider as any).getMessages === "function") {
      return await (provider as any).getMessages(sessionId);
    }
    return [];
  }
}

export const chatService = new ChatService();
