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

  /** List providers visible to users (excludes internal-only providers like mock) */
  list(): ProviderInfo[] {
    return Array.from(this.providers.values())
      .filter((p) => p.id !== "mock")
      .map((p) => ({ id: p.id, name: p.name }));
  }

  /** List all registered providers including internal ones (for ChatService aggregation) */
  listAll(): ProviderInfo[] {
    return Array.from(this.providers.values())
      .map((p) => ({ id: p.id, name: p.name }));
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

// SDK providers registered synchronously (no binary check needed)
providerRegistry.register(new ClaudeAgentSdkProvider());
providerRegistry.register(new MockProvider()); // testing only

/**
 * Bootstrap CLI providers asynchronously.
 * Checks isAvailable() before registering — call at server startup.
 */
export async function bootstrapProviders(): Promise<void> {
  try {
    const { CursorCliProvider } = await import("./cursor-cli/cursor-provider.ts");
    const cursor = new CursorCliProvider();
    if (await cursor.isAvailable()) {
      providerRegistry.register(cursor);
      // Ensure config has an entry for cursor so settings UI shows it
      const ai = configService.get("ai");
      if (!ai.providers["cursor"]) {
        configService.set("ai", {
          ...ai,
          providers: {
            ...ai.providers,
            cursor: { type: "cli", cli_command: "cursor-agent", permission_mode: "bypassPermissions" },
          },
        });
        configService.save();
      }
      console.log("[registry] Cursor provider registered (cursor-agent found)");
    } else {
      console.log("[registry] Cursor provider skipped (cursor-agent not found)");
    }
  } catch (e) {
    console.warn("[registry] Failed to load Cursor provider:", (e as Error).message);
  }
}
