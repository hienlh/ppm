/**
 * The inventory is refetched when a tick names a device it does not know — and
 * only once per such set. On a Mac the tick and the inventory run their tools
 * separately (`ioreg`, `ifconfig`, …), so the inventory's read can fail where the
 * tick's did not; the old rule ("refetch whenever an id is unknown", re-run after
 * every answer) then turned into a request loop for as long as the tool failed.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { act, useState } from "react";
import { mount, type Mounted } from "../../helpers/react-dom";
import type { HardwareInventory } from "../../../src/types/system-hardware";

const { api } = await import("../../../src/web/lib/api-client");
const { useHardwareInventory } = await import("../../../src/web/components/system/performance/use-hardware-inventory");

const inventory = (diskIds: string[]): HardwareInventory => ({
  platform: "darwin", ts: 1, nics: [], gpus: [],
  disks: diskIds.map((id) => ({ id, kind: "nvme", capacityBytes: 1, systemDisk: false, removable: false })),
});

let setIds: (ids: string) => void = () => {};
function Probe({ initial }: { initial: string }) {
  const [ids, set] = useState(initial);
  setIds = set;
  const inv = useHardwareInventory(ids);
  return <output>{inv?.disks.map((d) => d.id).join(",") ?? "none"}</output>;
}

/** Lets every fetch the last render started settle, and whatever it caused. */
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await Bun.sleep(5); });
}

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe("useHardwareInventory", () => {
  it("refetches once for a device it cannot name, then stops asking", async () => {
    const get = spyOn(api, "get").mockImplementation(async () => inventory([]) as never);
    try {
      view = await mount(<Probe initial="disk0" />);
      await settle();
      // The first load, and one refetch for disk0 — not one per answer.
      expect(get).toHaveBeenCalledTimes(2);
      await settle();
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      get.mockRestore();
    }
  });

  it("asks straight away about a device it has not asked about yet", async () => {
    const get = spyOn(api, "get").mockImplementation(async () => inventory([]) as never);
    try {
      view = await mount(<Probe initial="disk0" />);
      await settle();
      await act(async () => setIds("disk0,disk4"));
      await settle();
      expect(get).toHaveBeenCalledTimes(3);
    } finally {
      get.mockRestore();
    }
  });

  it("a refetch that names the device settles there", async () => {
    let answers = 0;
    const get = spyOn(api, "get").mockImplementation(async () => (answers++ === 0 ? inventory([]) : inventory(["disk4"])) as never);
    try {
      view = await mount(<Probe initial="disk4" />);
      await settle();
      expect(get).toHaveBeenCalledTimes(2);
      expect(view.container.textContent).toBe("disk4");
    } finally {
      get.mockRestore();
    }
  });

  it("a device that is known needs no refetch at all", async () => {
    const get = spyOn(api, "get").mockImplementation(async () => inventory(["disk0"]) as never);
    try {
      view = await mount(<Probe initial="disk0" />);
      await settle();
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      get.mockRestore();
    }
  });
});
