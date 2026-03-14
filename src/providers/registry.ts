import type { AIProvider } from "./provider.interface.ts";

export class ProviderRegistry {
  private providers = new Map<string, AIProvider>();
  private defaultId: string | undefined;

  register(provider: AIProvider, isDefault = false): void {
    this.providers.set(provider.id, provider);
    if (isDefault || !this.defaultId) {
      this.defaultId = provider.id;
    }
  }

  get(id: string): AIProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`Provider not found: ${id}`);
    return p;
  }

  list(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  getDefault(): AIProvider {
    if (!this.defaultId) throw new Error("No providers registered");
    return this.get(this.defaultId);
  }
}
