import { describe, test, expect } from "bun:test";
import {
  collectLinuxNicDevices,
  listNetInterfaces,
  nicState,
  toNicMetrics,
} from "../../../../src/services/system-metrics/net-devices-linux.ts";
import { fakeLinuxFs } from "./fixtures/fake-linux-fs.ts";

describe("listNetInterfaces", () => {
  test("loopback is excluded by its ARP type, not by its name", () => {
    const fs = fakeLinuxFs({
      dirs: { "/sys/class/net": ["enp3s0", "lo", "docker0", "localnet"] },
      files: {
        "/sys/class/net/enp3s0/type": "1",
        "/sys/class/net/lo/type": "772",
        "/sys/class/net/docker0/type": "1",
        // Mission Center drops anything starting with "lo"; this one is real.
        "/sys/class/net/localnet/type": "1",
      },
    });
    expect(listNetInterfaces(fs)).toEqual(["docker0", "enp3s0", "localnet"]);
  });

  test("an unreadable /sys/class/net is an empty list", () => {
    expect(listNetInterfaces(fakeLinuxFs({}))).toEqual([]);
  });
});

describe("nicState", () => {
  test("the kernel's operstate maps straight across", () => {
    expect(nicState("up", "1", "0x1003")).toBe("connected");
    expect(nicState("down", "0", "0x1003")).toBe("disconnected");
    expect(nicState("dormant", "0", "0x1003")).toBe("connecting");
    expect(nicState("testing", "0", "0x1003")).toBe("connecting");
    expect(nicState("lowerlayerdown", "0", "0x1003")).toBe("unavailable");
    expect(nicState("notpresent", "0", "0x1003")).toBe("unavailable");
  });

  test("tun and wireguard report 'unknown' forever, so carrier plus IFF_UP decides", () => {
    // tailscale0 and a wireguard link, verbatim off this repo's dev host.
    expect(nicState("unknown", "1", "0x1091")).toBe("connected");
    expect(nicState("unknown", "1", "0x91")).toBe("connected");
    // Administratively down: IFF_UP clear.
    expect(nicState("unknown", "1", "0x1002")).toBe("unknown");
    expect(nicState("unknown", "0", "0x1003")).toBe("unknown");
  });

  test("a missing operstate is unknown rather than a guess", () => {
    expect(nicState(undefined, undefined, undefined)).toBe("unknown");
    expect(nicState("weird", "1", "0x1")).toBe("unknown");
  });
});

describe("toNicMetrics", () => {
  test("first sample: unavailable, but the since-boot totals are real", () => {
    const m = toNicMetrics("enp3s0", null, { atSec: 0, rx: 500, tx: 200 });
    expect(m.available).toBe(false);
    expect(m.rxBps).toBe(0);
    expect(m.rxTotal).toBe(500);
    expect(m.txTotal).toBe(200);
  });

  test("rates are the byte delta over the interval", () => {
    const m = toNicMetrics("enp3s0", { atSec: 0, rx: 1000, tx: 500 }, { atSec: 2, rx: 5000, tx: 1500 });
    expect(m).toMatchObject({ available: true, rxBps: 2000, txBps: 500 });
  });

  test("an interface recreated under the same name resets its counters → one unavailable tick", () => {
    const m = toNicMetrics("wg0", { atSec: 0, rx: 9_000_000, tx: 9_000_000 }, { atSec: 1, rx: 12, tx: 4 });
    expect(m.available).toBe(false);
    expect(m.rxBps).toBe(0);
  });

  test("a zero interval is unavailable", () => {
    expect(toNicMetrics("e", { atSec: 3, rx: 0, tx: 0 }, { atSec: 3, rx: 9, tx: 9 }).available).toBe(false);
  });
});

describe("collectLinuxNicDevices", () => {
  const fs = fakeLinuxFs({
    dirs: { "/sys/class/net": ["enp3s0", "lo", "wg0"] },
    files: {
      "/sys/class/net/enp3s0/type": "1",
      "/sys/class/net/enp3s0/statistics/rx_bytes": "1000",
      "/sys/class/net/enp3s0/statistics/tx_bytes": "500",
      "/sys/class/net/enp3s0/operstate": "up",
      "/sys/class/net/enp3s0/carrier": "1",
      "/sys/class/net/enp3s0/flags": "0x1003",
      "/sys/class/net/enp3s0/speed": "2500",
      "/sys/class/net/lo/type": "772",
      "/sys/class/net/wg0/type": "65534",
      "/sys/class/net/wg0/statistics/rx_bytes": "20",
      "/sys/class/net/wg0/statistics/tx_bytes": "10",
      "/sys/class/net/wg0/operstate": "unknown",
      "/sys/class/net/wg0/carrier": "1",
      "/sys/class/net/wg0/flags": "0x91",
    },
  });

  test("negotiated speed rides along in Mbit/s; an interface with no link has none", () => {
    const { nics } = collectLinuxNicDevices(new Map(), fs, () => 0);
    expect(nics.find((n) => n.id === "enp3s0")?.linkMbps).toBe(2500);
    expect("linkMbps" in (nics.find((n) => n.id === "wg0") ?? {})).toBe(false);
  });

  test("state comes from the kernel, so a wireguard link reads connected", () => {
    const { nics } = collectLinuxNicDevices(new Map(), fs, () => 0);
    expect(nics.map((n) => [n.id, n.state])).toEqual([["enp3s0", "connected"], ["wg0", "connected"]]);
  });

  test("second tick measures each interface against its own baseline", () => {
    const first = collectLinuxNicDevices(new Map(), fs, () => 0);
    const second = collectLinuxNicDevices(first.next, fs, () => 2000);
    expect(second.nics[0]?.available).toBe(true);
    expect(second.nics[0]?.rxBps).toBe(0);
  });

  test("wireless facts are merged in as data — the collector spawns nothing itself", () => {
    const wireless = new Map([["enp3s0", { ssid: "Home", signalPercent: 78, frequencyMHz: 5180 }]]);
    const { nics } = collectLinuxNicDevices(new Map(), fs, () => 0, wireless);
    expect(nics[0]).toMatchObject({ ssid: "Home", signalPercent: 78, frequencyMHz: 5180 });
    expect("ssid" in (nics[1] ?? {})).toBe(false);
  });

  test("an interface with no byte counters is skipped rather than reported as zero", () => {
    const broken = fakeLinuxFs({
      dirs: { "/sys/class/net": ["bond0"] },
      files: { "/sys/class/net/bond0/type": "1" },
    });
    expect(collectLinuxNicDevices(new Map(), broken, () => 0).nics).toEqual([]);
  });
});
