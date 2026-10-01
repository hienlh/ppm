/**
 * Static device facts for the Performance page.
 *
 * Fetched once, then again only when a snapshot names a device id the inventory
 * has never heard of — a USB drive plugged in, an interface created. It is a
 * ~2.8 KB payload of things that do not change tick to tick (models, capacities,
 * MAC addresses, DIMM layout), so putting it on the 2 s stream would be pure
 * waste over a tunnel.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import type { HardwareInventory } from "../../../../types/system-hardware";

/** How long to wait before asking again about ids the last answer still could
 *  not name. */
export const INVENTORY_RETRY_MS = 30_000;

/** `deviceIds` is a JOINED string, not an array: an array literal is a fresh
 *  identity every render, which would turn the refetch effect into a loop. */
export function useHardwareInventory(deviceIds: string): HardwareInventory | null {
  const [inventory, setInventory] = useState<HardwareInventory | null>(null);
  const inFlight = useRef(false);
  const askedFor = useRef("");

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setInventory(await api.get<HardwareInventory>("/api/system/hardware"));
    } catch {
      // The pages degrade to the ids the tick already carries rather than
      // showing an error over a whole page of otherwise-live figures.
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!inventory) return;
    const known = new Set<string>([
      ...inventory.disks.map((d) => d.id),
      ...inventory.nics.map((n) => n.id),
      ...inventory.gpus.map((g) => g.id),
    ]);
    const unknown = deviceIds.split(",").filter((id) => id && !known.has(id)).join(",");
    if (!unknown) {
      askedFor.current = "";
      return;
    }
    if (unknown !== askedFor.current) {
      askedFor.current = unknown;
      void load();
      return;
    }
    // Asked already, and the answer still cannot name them. On a Mac the tick and
    // the inventory run their tools separately, so one can fail where the other
    // did not; asking again straight away would refetch after every answer, back
    // to back, for as long as that lasts.
    const retry = setTimeout(() => void load(), INVENTORY_RETRY_MS);
    return () => clearTimeout(retry);
  }, [inventory, deviceIds, load]);

  return inventory;
}
