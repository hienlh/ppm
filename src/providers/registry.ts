import type { AIProvider } from "./provider.interface.ts";
import { MockProvider } from "./mock-provider.ts";
import { ClaudeAgentSdkProvider } from "./claude-agent-sdk.ts";
import { configService } from "../services/config.service.ts";

export interface ProviderInfo {
  id: string;
  name: string;
}

class ProviderRegistry {
  private providers = new Map<string, AIProvider>();

  register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
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

  /** Get the default provider based on config's default_provider */
  getDefault(): AIProvider {
    const defaultId = configService.get("ai").default_provider;
    const provider = this.providers.get(defaultId);
    if (provider) return provider;
    // Fallback to "claude" if config value doesn't match any registered provider
    const fallback = this.providers.get("claude");
    if (fallback) return fallback;
    throw new Error(`Default provider "${defaultId}" not found in registry`);
  }
}

/** Singleton registry */
export const providerRegistry = new ProviderRegistry();
providerRegistry.register(new ClaudeAgentSdkProvider());
providerRegistry.register(new MockProvider()); // testing only
