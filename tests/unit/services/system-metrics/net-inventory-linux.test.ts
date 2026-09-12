import { describe, test, expect } from "bun:test";
import {
  kindFromName,
  nicKind,
  readNicInfo,
  readNicInventory,
} from "../../../../src/services/system-metrics/net-inventory-linux.ts";
import { fakeLinuxFs } from "./fixtures/fake-linux-fs.ts";

const withUevent = (id: string, devtype: string | null, extra: Record<string, string> = {}) =>
  fakeLinuxFs({
    files: {
      [`/sys/class/net/${id}/uevent`]: `INTERFACE=${id}\n${devtype ? `DEVTYPE=${devtype}\n` : ""}IFINDEX=2\n`,
      ...extra,
    },
  });

describe("nicKind", () => {
  test("sysfs answers for wireguard, bridges and docker before any name rule", () => {
    expect(nicKind("thangho", withUevent("thangho", "wireguard"))).toBe("vpn");
    expect(nicKind("incusbr0", withUevent("incusbr0", "bridge"))).toBe("bridge");
    expect(nicKind("docker0", withUevent("docker0", "bridge"))).toBe("docker");
  });

  test("a wireless interface is one with a wireless directory, whatever it is called", () => {
    const fs = fakeLinuxFs({ dirs: { "/sys/class/net/mlan0/wireless": [] } });
    expect(nicKind("mlan0", fs)).toBe("wireless");
    expect(nicKind("wlp2s0", withUevent("wlp2s0", "wlan"))).toBe("wireless");
  });

  test("infiniband is the ARP type, not the name", () => {
    const fs = withUevent("ibp5s0", null, { "/sys/class/net/ibp5s0/type": "32" });
    expect(nicKind("ibp5s0", fs)).toBe("infiniband");
  });

  test("a TUN device is a tunnel — Mission Center files every one under 'other'", () => {
    const fs = withUevent("tailscale0", null, { "/sys/class/net/tailscale0/tun_flags": "0x5001" });
    expect(nicKind("tailscale0", fs)).toBe("vpn");
    expect(kindFromName("tailscale0")).toBe("other");
  });

  test("with nothing in sysfs to go on it falls back to Mission Center's prefixes", () => {
    expect(nicKind("enp3s0", withUevent("enp3s0", null))).toBe("wired");
    expect(nicKind("veth1a2b", withUevent("veth1a2b", null))).toBe("virtual");
  });
});

describe("kindFromName", () => {
  test("Mission Center's table, order included", () => {
    expect(kindFromName("bnep0")).toBe("bluetooth");
    expect(kindFromName("br0")).toBe("bridge");
    expect(kindFromName("virbr0")).toBe("bridge");
    expect(kindFromName("docker0")).toBe("docker");
    expect(kindFromName("eth0")).toBe("wired");
    expect(kindFromName("enp3s0")).toBe("wired");
    expect(kindFromName("ib0")).toBe("infiniband");
    expect(kindFromName("mpqemubr0")).toBe("multipass");
    expect(kindFromName("veth0")).toBe("virtual");
    expect(kindFromName("wg0")).toBe("vpn");
    expect(kindFromName("vpn0")).toBe("vpn");
    expect(kindFromName("wlp2s0")).toBe("wireless");
    expect(kindFromName("wwan0")).toBe("wireless");
    expect(kindFromName("zzz0")).toBe("other");
  });
});

describe("readNicInfo", () => {
  const fs = fakeLinuxFs({
    files: {
      "/sys/class/net/enp3s0/ifindex": "2",
      "/sys/class/net/enp3s0/address": "d8:5e:d3:5b:9f:d6",
      "/sys/class/net/enp3s0/uevent": "INTERFACE=enp3s0\nIFINDEX=2\n",
      "/run/udev/data/n2": [
        "E:ID_NET_DRIVER=r8169",
        "E:ID_VENDOR_FROM_DATABASE=Realtek Semiconductor Co., Ltd.",
        "E:ID_MODEL_FROM_DATABASE=RTL8125 2.5GbE Controller",
      ].join("\n"),
    },
  });

  test("the adapter's marketing name and driver come from udev's own database", () => {
    const info = readNicInfo("enp3s0", fs, { ipv4: ["192.168.1.10"], ipv6: ["fe80::1"] });
    expect(info).toEqual({
      id: "enp3s0",
      kind: "wired",
      deviceName: "RTL8125 2.5GbE Controller",
      driver: "r8169",
      mac: "d8:5e:d3:5b:9f:d6",
      ipv4: ["192.168.1.10"],
      ipv6: ["fe80::1"],
    });
  });

  test("with no udev record the driver still resolves from the sysfs symlink", () => {
    const noUdev = fakeLinuxFs({
      files: { "/sys/class/net/enp4s0/ifindex": "3", "/sys/class/net/enp4s0/uevent": "" },
      links: { "/sys/class/net/enp4s0/device/driver": "../../../../bus/pci/drivers/ixgbe" },
    });
    const info = readNicInfo("enp4s0", noUdev, undefined);
    expect(info.driver).toBe("ixgbe");
    expect("deviceName" in info).toBe(false);
  });

  test("an interface with no hardware address has no mac key at all", () => {
    const virt = fakeLinuxFs({ files: { "/sys/class/net/wg0/ifindex": "6", "/sys/class/net/wg0/uevent": "DEVTYPE=wireguard" } });
    const info = readNicInfo("wg0", virt, undefined);
    expect("mac" in info).toBe(false);
    expect(info).toMatchObject({ kind: "vpn", ipv4: [], ipv6: [] });
  });
});

describe("readNicInventory", () => {
  test("one entry per non-loopback interface, addresses injected", () => {
    const fs = fakeLinuxFs({
      dirs: { "/sys/class/net": ["enp3s0", "lo"] },
      files: {
        "/sys/class/net/enp3s0/type": "1",
        "/sys/class/net/enp3s0/ifindex": "2",
        "/sys/class/net/enp3s0/uevent": "",
        "/sys/class/net/lo/type": "772",
      },
    });
    const nics = readNicInventory(fs, () => ({ enp3s0: { ipv4: ["10.0.0.2"], ipv6: [] } }));
    expect(nics).toEqual([{ id: "enp3s0", kind: "wired", ipv4: ["10.0.0.2"], ipv6: [] }]);
  });
});
