/** The interface inventory on macOS, from the same real captures the tick parses. */
import { describe, expect, test } from "bun:test";
import {
  buildDarwinNicInventory, darwinNicKind, readDarwinNicInventory,
} from "../../../../src/services/system-metrics/net-inventory-darwin.ts";
import {
  listDarwinInterfaces, parseIfconfig, parseServiceOrder, type DarwinInterface,
} from "../../../../src/services/system-metrics/net-devices-darwin.ts";
import type { DarwinToolReads } from "../../../../src/services/system-metrics/darwin-tool-reads.ts";
import { darwinFixture } from "./fixtures/darwin-fixture.ts";

const IFACES = parseIfconfig(darwinFixture("ifconfig-av.txt"));
const SERVICES = parseServiceOrder(darwinFixture("networksetup-serviceorder.txt"));
const ADDRESSES = { en0: { ipv4: ["192.0.2.10"], ipv6: ["fe80::1"] } };

const iface = (over: Partial<DarwinInterface>): DarwinInterface => ({
  id: "en9", flags: [], xflags: [], members: [], ...over,
});

describe("darwinNicKind", () => {
  test("names each kind the capture has", () => {
    const kinds = Object.fromEntries(
      buildDarwinNicInventory(IFACES, SERVICES, {}).map((n) => [n.id, n.kind]),
    );
    expect(kinds).toEqual({
      en7: "wired", en0: "wireless", bridge0: "bridge",
      bridge100: "bridge", bridge101: "bridge", bridge102: "bridge",
      utun4: "vpn", utun5: "vpn",
    });
  });

  test("a Bluetooth PAN port, and the name prefixes when nothing else says", () => {
    expect(darwinNicKind(iface({ id: "en5" }), "Bluetooth PAN")).toBe("bluetooth");
    expect(darwinNicKind(iface({ id: "en9" }), undefined)).toBe("wired");
    expect(darwinNicKind(iface({ id: "ppp0" }), undefined)).toBe("other");
  });
});

describe("buildDarwinNicInventory", () => {
  const nics = buildDarwinNicInventory(IFACES, SERVICES, ADDRESSES);
  const byId = (id: string) => nics.find((n) => n.id === id);

  test("lists exactly the interfaces the tick lists", () => {
    expect(nics.map((n) => n.id)).toEqual(listDarwinInterfaces(IFACES, SERVICES));
  });

  test("names each by its port, its VPN, or what its bridge is for", () => {
    expect(byId("en0")).toEqual({
      id: "en0", kind: "wireless", deviceName: "Wi-Fi", mac: "00:00:5e:00:53:0b",
      ipv4: ["192.0.2.10"], ipv6: ["fe80::1"],
    });
    expect(byId("bridge0")?.deviceName).toBe("Thunderbolt Bridge");
    expect(byId("utun4")?.deviceName).toBe("Example Mesh");
    expect(byId("bridge100")?.deviceName).toBe("Network Sharing");
  });

  test("a tunnel has no hardware address and no driver to report", () => {
    expect("mac" in byId("utun4")!).toBe(false);
    expect(nics.some((n) => "driver" in n)).toBe(false);
  });
});

describe("readDarwinNicInventory", () => {
  const reads = (over: Partial<DarwinToolReads>): DarwinToolReads => ({
    blockDevices: async () => undefined,
    accelerators: async () => undefined,
    netstat: async () => undefined,
    diskutilList: async () => undefined,
    mounts: async () => undefined,
    ifconfig: async () => ({ value: darwinFixture("ifconfig-av.txt"), atSec: 1 }),
    serviceOrder: async () => ({ value: darwinFixture("networksetup-serviceorder.txt"), atSec: 1 }),
    ...over,
  });

  test("reads the two tools and the addresses", async () => {
    const nics = await readDarwinNicInventory(reads({}), () => ADDRESSES);
    expect(nics.find((n) => n.id === "en0")?.ipv4).toEqual(["192.0.2.10"]);
    expect(nics).toHaveLength(8);
  });

  test("with ifconfig failing there is nothing to list, and nothing throws", async () => {
    expect(await readDarwinNicInventory(reads({ ifconfig: async () => undefined }), () => ADDRESSES)).toEqual([]);
  });

  test("with networksetup failing it falls back to the linked hardware, as the tick does", async () => {
    const nics = await readDarwinNicInventory(reads({ serviceOrder: async () => undefined }), () => ADDRESSES);
    expect(nics.map((n) => n.id)).toEqual(listDarwinInterfaces(IFACES, undefined));
  });
});
