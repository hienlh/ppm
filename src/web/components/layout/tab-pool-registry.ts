/**
 * Slot registry — panels publish the element their tab content should live in.
 *
 * Split out of tab-pool.tsx so the pool and the reparenting wrapper can both reach it
 * without importing each other.
 *
 * Registering an element is a subscription event, not a render input: TabPool subscribes
 * through useSyncExternalStore, so a panel mounting late still gets its tab moved in.
 */
type SlotListener = () => void;

class SlotRegistry {
  private slots = new Map<string, HTMLDivElement>();
  private listeners = new Set<SlotListener>();
  private version = 0;

  register(panelId: string, el: HTMLDivElement | null) {
    if (el) {
      if (this.slots.get(panelId) === el) return;
      this.slots.set(panelId, el);
    } else {
      if (!this.slots.has(panelId)) return;
      this.slots.delete(panelId);
    }
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  get(panelId: string): HTMLDivElement | undefined {
    return this.slots.get(panelId);
  }

  subscribe(fn: SlotListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getVersion(): number {
    return this.version;
  }
}

export const slotRegistry = new SlotRegistry();

/** Called by a panel (grid, dock or floating window) to register its content slot. */
export function registerPanelSlot(panelId: string, el: HTMLDivElement | null) {
  slotRegistry.register(panelId, el);
}
