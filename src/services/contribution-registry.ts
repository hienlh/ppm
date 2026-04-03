import type { ExtensionContributes, ContributedCommand, ContributedView, ContributedMenu } from "../types/extension.ts";

/**
 * In-memory registry of all contribution points from enabled extensions.
 * Populated when extensions activate, cleared when they deactivate.
 */
class ContributionRegistry {
  private commands = new Map<string, ContributedCommand & { extId: string }>();
  private views = new Map<string, Map<string, ContributedView & { extId: string }>>();
  private configs = new Map<string, Record<string, unknown>>();
  private menus = new Map<string, Array<ContributedMenu & { extId: string }>>();

  register(extId: string, contributes: ExtensionContributes): void {
    if (contributes.commands) {
      for (const cmd of contributes.commands) {
        this.commands.set(cmd.command, { ...cmd, extId });
      }
    }
    if (contributes.views) {
      for (const [location, views] of Object.entries(contributes.views)) {
        if (!this.views.has(location)) this.views.set(location, new Map());
        const locationMap = this.views.get(location)!;
        for (const view of views) {
          locationMap.set(view.id, { ...view, extId });
        }
      }
    }
    if (contributes.configuration?.properties) {
      this.configs.set(extId, contributes.configuration.properties);
    }
    if (contributes.menus) {
      for (const [location, items] of Object.entries(contributes.menus)) {
        if (!this.menus.has(location)) this.menus.set(location, []);
        const list = this.menus.get(location)!;
        for (const item of items) {
          list.push({ ...item, extId });
        }
      }
    }
  }

  unregister(extId: string): void {
    for (const [key, cmd] of this.commands) {
      if (cmd.extId === extId) this.commands.delete(key);
    }
    for (const [, locationMap] of this.views) {
      for (const [key, view] of locationMap) {
        if (view.extId === extId) locationMap.delete(key);
      }
    }
    for (const [location, items] of this.menus) {
      this.menus.set(location, items.filter((m) => m.extId !== extId));
    }
    this.configs.delete(extId);
  }

  getCommands(): Array<ContributedCommand & { extId: string }> {
    return [...this.commands.values()];
  }

  getViews(location?: string): Array<ContributedView & { extId: string }> {
    if (location) {
      return [...(this.views.get(location)?.values() ?? [])];
    }
    const all: Array<ContributedView & { extId: string }> = [];
    for (const locationMap of this.views.values()) {
      all.push(...locationMap.values());
    }
    return all;
  }

  getViewLocations(): string[] {
    return [...this.views.keys()];
  }

  getConfiguration(extId?: string): Record<string, Record<string, unknown>> {
    if (extId) {
      const cfg = this.configs.get(extId);
      return cfg ? { [extId]: cfg } : {};
    }
    return Object.fromEntries(this.configs);
  }

  /** Get all contributions as a single object (for API responses) */
  getAll() {
    const viewsByLocation: Record<string, Array<ContributedView & { extId: string }>> = {};
    for (const location of this.views.keys()) {
      viewsByLocation[location] = this.getViews(location);
    }
    const menusByLocation: Record<string, Array<ContributedMenu & { extId: string }>> = {};
    for (const [location, items] of this.menus) {
      menusByLocation[location] = items;
    }
    return {
      commands: this.getCommands(),
      views: viewsByLocation,
      menus: menusByLocation,
      configuration: this.getConfiguration(),
    };
  }

  clear(): void {
    this.commands.clear();
    this.views.clear();
    this.configs.clear();
    this.menus.clear();
  }
}

export const contributionRegistry = new ContributionRegistry();
