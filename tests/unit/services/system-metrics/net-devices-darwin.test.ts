/**
 * Per-interface figures on macOS, from real captures of one M1 Max: `ifconfig
 * -a -v` with its 32 interfaces, `netstat -ib`, and the service list System
 * Settings shows. Addresses in the captures are documentation ranges.
 */
import { describe, expect, test } from "bun:test";
import {
  collectDarwinNicDevices, darwinNicState, listDarwinInterfaces, parseIfconfig, parseNetstatLinks,
  parseServiceOrder, sumNetCounters, type DarwinInterface,
} from "../../../../src/services/system-metrics/net-devices-darwin.ts";
import { darwinFixture } from "./fixtures/darwin-fixture.ts";

const IFACES = parseIfconfig(darwinFixture("ifconfig-av.txt"));
const SERVICES = parseServiceOrder(darwinFixture("networksetup-serviceorder.txt"));
const LINKS = parseNetstatLinks(darwinFixture("netstat-ib.txt"));

const iface = (over: Partial<DarwinInterface>): DarwinInterface => ({
  id: "en9", flags: ["UP", "RUNNING"], xflags: [], members: [], ...over,
});

describe("parseIfconfig", () => {
  test("reads every interface in the capture", () => {
    expect(IFACES.size).toBe(32);
  });

  test("reads Wi-Fi's link state, type, hardware address and the driver's rate estimate", () => {
    expect(IFACES.get("en0")).toMatchObject({
      status: "active", type: "Wi-Fi", mac: "00:00:5e:00:53:0b",
      // "downlink rate: 29.15 Mbps [eff] / 97.11 Mbps [max]" — the maximum.
      linkMbps: 97.11,
    });
  });

  test("reads a symmetric link's single rate", () => {
    expect(IFACES.get("vmenet0")?.linkMbps).toBe(100);
    const [gig] = parseIfconfig("en8: flags=8863<UP,RUNNING> mtu 1500\n\tlink rate: 2.50 Gbps\n").values();
    expect(gig?.linkMbps).toBe(2500);
  });

  test("reads a VPN tunnel's name from its NetworkExtension agent", () => {
    expect(IFACES.get("utun4")).toMatchObject({ xflags: ["NOAUTONX", "IS_VPN"], vpnName: "Example Mesh" });
    expect(IFACES.get("utun5")?.vpnName).toBe("Example WireGuard");
    // An iCloud or Continuity agent's tunnel is not a VPN.
    expect(IFACES.get("utun0")?.xflags).not.toContain("IS_VPN");
  });

  test("reads a bridge's members, and what a sharing bridge says it is", () => {
    expect(IFACES.get("bridge0")?.members).toEqual(["en1", "en2", "en3"]);
    expect(IFACES.get("bridge100")).toMatchObject({ members: ["vmenet0"], description: "com.apple.NetworkSharing" });
  });

  test("an agent's quoted desc is not the interface's own description", () => {
    expect(IFACES.get("en0")?.description).toBeUndefined();
    expect(IFACES.get("utun4")?.description).toBeUndefined();
  });
});

describe("parseServiceOrder", () => {
  test("maps each service's device to its hardware port, skipping device-less services", () => {
    expect([...SERVICES]).toEqual([
      ["en7", "USB Ethernet Adapter"],
      ["en8", "USB 10/100/1G/2.5G LAN"],
      ["en0", "Wi-Fi"],
      ["bridge0", "Thunderbolt Bridge"],
      ["en11", "iPhone USB"],
    ]);
  });
});

describe("parseNetstatLinks", () => {
  test("reads each interface's link row once, tunnels with no address included", () => {
    expect(LINKS.get("en0")).toEqual({ rx: 45514240009, tx: 44614975491 });
    expect(LINKS.get("utun4")).toEqual({ rx: 8919472073, tx: 1668721694 });
    expect(LINKS.get("utun0")).toEqual({ rx: 0, tx: 80 });
  });

  test("a down interface's trailing asterisk is not part of its name", () => {
    expect(LINKS.has("gif0")).toBe(true);
    expect(LINKS.has("gif0*")).toBe(false);
  });
});

describe("sumNetCounters", () => {
  test("sums every interface but loopback, as the Network card always has", () => {
    expect(sumNetCounters(LINKS)).toEqual({ inBytes: 54462080808, outBytes: 46300221096 });
  });

  test("is null when there is nothing but loopback", () => {
    expect(sumNetCounters(new Map([["lo0", { rx: 1, tx: 1 }]]))).toBeNull();
  });
});

describe("listDarwinInterfaces", () => {
  test("lists what System Settings lists, then VPNs and VM bridges, and none of the plumbing", () => {
    expect(listDarwinInterfaces(IFACES, SERVICES)).toEqual([
      "en7", "en0", "bridge0", "bridge100", "bridge101", "bridge102", "utun4", "utun5",
    ]);
  });

  test("a service whose adapter is not plugged in has no interface to list", () => {
    expect(listDarwinInterfaces(IFACES, SERVICES)).not.toContain("en11");
  });

  test("without the service list, keeps the linked hardware and drops the Wi-Fi chip's companions", () => {
    expect(listDarwinInterfaces(IFACES, undefined)).toEqual([
      "bridge100", "bridge101", "bridge102", "en0", "utun4", "utun5",
    ]);
  });
});

describe("darwinNicState", () => {
  test("follows ifconfig's status, and a tunnel's flags where it prints none", () => {
    expect(darwinNicState(IFACES.get("en0")!)).toBe("connected");
    expect(darwinNicState(IFACES.get("en7")!)).toBe("disconnected");
    expect(darwinNicState(IFACES.get("utun4")!)).toBe("connected");
    expect(darwinNicState(iface({ flags: ["UP"] }))).toBe("unknown");
    expect(darwinNicState(iface({ flags: ["POINTOPOINT"] }))).toBe("disconnected");
  });
});

describe("collectDarwinNicDevices", () => {
  const input = (atSec: number, links = LINKS) => ({ links, atSec, ifaces: IFACES, services: SERVICES });

  test("rates each interface against its own baseline", () => {
    const first = collectDarwinNicDevices(new Map(), input(100));
    expect(first.nics.every((n) => !n.available)).toBe(true);
    const later = new Map(LINKS);
    later.set("en0", { rx: 45514240009 + 2_000_000, tx: 44614975491 + 500_000 });
    const second = collectDarwinNicDevices(first.next, input(102, later));
    expect(second.nics.find((n) => n.id === "en0")).toMatchObject({
      available: true, rxBps: 1_000_000, txBps: 250_000, state: "connected", linkMbps: 97.11,
    });
    expect(second.nics.map((n) => n.id)).toEqual(listDarwinInterfaces(IFACES, SERVICES));
  });

  test("puts the radio's facts on the Wi-Fi interface only, its transmit rate over the driver's estimate", () => {
    const wifi = { interfaceName: "en0", rssiDbm: -70, transmitRateMbps: 286, channel: 36, band: 2 };
    const { nics } = collectDarwinNicDevices(new Map(), { ...input(1), wifi });
    expect(nics.find((n) => n.id === "en0")).toMatchObject({ linkMbps: 286, signalPercent: 50, frequencyMHz: 5180 });
    const others = nics.filter((n) => n.id !== "en0");
    expect(others.some((n) => n.signalPercent !== undefined || n.frequencyMHz !== undefined)).toBe(false);
  });

  test("an interface netstat does not count is left out rather than shown at zero", () => {
    const partial = new Map(LINKS);
    partial.delete("utun5");
    expect(collectDarwinNicDevices(new Map(), input(1, partial)).nics.map((n) => n.id)).not.toContain("utun5");
  });
});
