import type { AIProvider } from "./provider.interface.ts";
import { MockProvider } from "./mock-provider.ts";
import { ClaudeCodeCliProvider } from "./claude-code-cli.ts";

export interface ProviderInfo {
  id: string;
  name: string;
}

class ProviderRegistry {
  private providers = new Map<string, AIProvider>();
  private defaultId: string | null = null;

  register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
    if (!this.defaultId) {
      this.defaultId = provider.id;
    }
  }

  get(id: string): AIProvider | undefined {
    return this.providers.get(id);
  }

  list(): ProviderInfo[] {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.id,
      name: p.name,
    }));
  }

  getDefault(): AIProvider {
    if (!this.defaultId) throw new Error("No providers registered");
    const provider = this.providers.get(this.defaultId);
    if (!provider) throw new Error("Default provider not found");
    return provider;
  }
}

/** Singleton registry — Claude Code CLI as default, mock for testing */
export const providerRegistry = new ProviderRegistry();
providerRegistry.register(new ClaudeCodeCliProvider());
providerRegistry.register(new MockProvider());
