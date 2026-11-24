import { describe, expect, it } from "bun:test";
import {
  classifyAddress, isMetadataHostName, localNetworkFrom, type AddressPolicyContext, type EgressBlockReason,
} from "../../../../src/services/web-browser/address-policy.ts";

const OWN_LAN = "192.168.1.50";
const PPM_PORT = 8080;

function ctx(over: Partial<AddressPolicyContext> = {}): AddressPolicyContext {
  return {
    allowLocalhost: true,
    allowLan: true,
    blockedLocalPorts: [PPM_PORT],
    port: 443,
    ownAddresses: ["127.0.0.1", "::1", OWN_LAN, "203.0.113.7", "2001:db8:5:6::10"],
    onLinkPrefixes: ["2001:db8:5:6::10/64", "130.10.20.5/24"],
    broadcastAddresses: ["192.168.1.255"],
    ...over,
  };
}

const verdict = (ip: string, over: Partial<AddressPolicyContext> = {}) => {
  const v = classifyAddress(ip, ctx(over));
  return v.ok ? "ok" : v.reason;
};

const ALL_OFF = { allowLocalhost: false, allowLan: false };

describe("classifyAddress", () => {
  const always: [string, EgressBlockReason][] = [
    ["0.0.0.0", "private-address"], ["0.255.255.255", "private-address"],
    ["224.0.0.0", "private-address"], ["239.255.255.255", "private-address"],
    ["240.0.0.1", "private-address"], ["255.255.255.255", "private-address"],
    ["::", "private-address"], ["ff02::1", "private-address"], ["ffff:ffff::1", "private-address"],
    ["192.168.1.255", "private-address"],
    ["169.254.169.254", "metadata"], ["169.254.170.2", "metadata"], ["169.254.169.253", "metadata"],
    ["100.100.100.200", "metadata"], ["fd00:ec2::254", "metadata"],
    ["::ffff:169.254.169.254", "metadata"], ["64:ff9b::a9fe:a9fe", "metadata"],
  ];
  it.each(always)("%s is refused with every switch on", (ip, reason) => {
    expect(verdict(ip)).toBe(reason);
    expect(verdict(ip, ALL_OFF)).toBe(reason);
  });

  const lan = [
    "10.0.0.0", "10.255.255.255", "172.16.0.0", "172.31.255.255", "192.168.0.0", "192.168.255.254",
    "100.64.0.0", "100.127.255.255", "169.254.0.1", "169.254.255.254", "198.18.0.0", "198.19.255.255",
    "fc00::", "fdff:ffff::1", "fe80::", "febf:ffff::1",
    // An IPv6 neighbour on this machine's /64 and an IPv4 neighbour on its public /24.
    "2001:db8:5:6::99", "130.10.20.200",
    "::ffff:10.1.2.3", "2002:c0a8:0101::1", "64:ff9b::192.168.1.1",
  ];
  it.each(lan)("%s follows allowLan", (ip) => {
    expect(verdict(ip, { allowLan: true })).toBe("ok");
    expect(verdict(ip, { allowLan: false })).toBe("private-address");
  });

  const publicAddresses = [
    "9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0",
    "100.63.255.255", "100.128.0.0", "169.253.255.255", "169.255.0.0", "198.17.255.255", "198.20.0.0",
    "223.255.255.255", "1.1.1.1", "2606:4700::1111", "fbff:ffff::1", "fec0::1", "2001:db8:5:7::1",
    "::ffff:8.8.8.8",
  ];
  it.each(publicAddresses)("%s is public and allowed with every switch off", (ip) => {
    expect(verdict(ip, ALL_OFF)).toBe("ok");
  });

  const self = ["127.0.0.1", "127.255.255.254", "::1", "::ffff:127.0.0.1", OWN_LAN, "203.0.113.7", "2001:db8:5:6::10"];
  it.each(self)("%s (this machine) follows allowLocalhost", (ip) => {
    expect(verdict(ip, { allowLocalhost: true, allowLan: false })).toBe("ok");
    expect(verdict(ip, { allowLocalhost: false, allowLan: true })).toBe("private-address");
  });

  it.each(self)("%s with a PPM port is refused whatever the switches say", (ip) => {
    expect(verdict(ip, { port: PPM_PORT })).toBe("own-port");
    expect(verdict(ip, { port: PPM_PORT, ...ALL_OFF })).toBe("own-port");
  });

  it("refuses this machine's LAN address on PPM's port but lets the router's port 80 through", () => {
    expect(verdict(OWN_LAN, { port: PPM_PORT })).toBe("own-port");
    expect(verdict("192.168.1.1", { port: 80, allowLan: true })).toBe("ok");
    expect(verdict("192.168.1.1", { port: 80, allowLan: false })).toBe("private-address");
  });

  it("does not apply PPM's ports to other machines", () => {
    expect(verdict("192.168.1.1", { port: PPM_PORT })).toBe("ok");
    expect(verdict("1.1.1.1", { port: PPM_PORT })).toBe("ok");
  });

  it("judges 6to4 and Teredo by the IPv4 address they carry", () => {
    expect(verdict("2002:7f00:0001::1", { blockedLocalPorts: [443] })).toBe("own-port");
    expect(verdict("2002:0808:0808::1", ALL_OFF)).toBe("ok");
    // Teredo client 10.0.0.1, obfuscated (bits inverted) in the last 32 bits.
    expect(verdict("2001:0:4136:e378:8000:63bf:f5ff:fffe", { allowLan: false })).toBe("private-address");
    expect(verdict("2001:0:4136:e378:8000:63bf:f7f7:f7f7", ALL_OFF)).toBe("ok");
  });

  it("ignores an IPv6 scope id and refuses garbage", () => {
    expect(verdict("fe80::1%12", { allowLan: false })).toBe("private-address");
    expect(verdict("not-an-ip", { allowLan: true })).toBe("private-address");
  });
});

describe("isMetadataHostName", () => {
  it.each(["metadata.google.internal", "METADATA", "metadata.azure.internal.", " metadata "])("%s is a metadata name", (n) => {
    expect(isMetadataHostName(n)).toBe(true);
  });
  it("does not match names that merely contain it", () => {
    expect(isMetadataHostName("metadata.example.com")).toBe(false);
  });
});

describe("localNetworkFrom", () => {
  it("collects addresses, subnets and broadcast addresses", () => {
    const net = localNetworkFrom({
      lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "", internal: true, cidr: "127.0.0.1/8" }],
      eth0: [
        { address: "192.168.1.50", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "192.168.1.50/24" },
        { address: "2001:db8:5:6::10", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "2001:db8:5:6::10/64", scopeid: 0 },
        { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "fe80::1/64", scopeid: 4 },
      ],
      vpn: [{ address: "45.1.2.3", netmask: "0.0.0.0", family: "IPv4", mac: "", internal: false, cidr: "45.1.2.3/0" }],
    });
    expect(net.ownAddresses).toEqual(["127.0.0.1", "192.168.1.50", "2001:db8:5:6::10", "fe80::1", "45.1.2.3"]);
    expect(net.onLinkPrefixes).toEqual(["192.168.1.50/24", "2001:db8:5:6::10/64"]);
    expect(net.broadcastAddresses).toEqual(["192.168.1.255"]);
  });
});
