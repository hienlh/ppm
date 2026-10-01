/**
 * Static facts about each network interface on macOS: what kind it is, the port
 * or VPN it belongs to, its MAC and addresses — for exactly the interfaces the
 * tick lists (`listDarwinInterfaces`), so the client never waits on an id the
 * inventory cannot name.
 *
 * `driver` is left out. A Mac's network drivers are IOKit classes and DriverKit
 * bundles (`AppleBCMWLANSkywalkInterface`, `com.apple.driver.usb.cdc.ncm`) that
 * name nothing a person would recognise, unlike Linux's `r8169` or `iwlwifi`.
 */
import type { NicInfo, NicKind } from "../../types/system-hardware.ts";
import type { DarwinToolReads } from "./darwin-tool-reads.ts";
import { kindFromName, readAddresses, type AddressMap } from "./net-inventory-linux.ts";
import {
  listDarwinInterfaces, NETWORK_SHARING, parseIfconfig, parseServiceOrder, type DarwinInterface,
} from "./net-devices-darwin.ts";

/** What a sharing bridge is called here, since the bridge itself has no name. */
const SHARING_NAME = "Network Sharing";

export function darwinNicKind(i: DarwinInterface, port: string | undefined): NicKind {
  if (i.xflags.includes("IS_VPN")) return "vpn";
  if (port !== undefined && /bluetooth/i.test(port)) return "bluetooth";
  if (i.type === "Wi-Fi") return "wireless";
  if (i.members.length > 0 || i.description === NETWORK_SHARING) return "bridge";
  if (i.type !== undefined && /ethernet|thunderbolt/i.test(i.type)) return "wired";
  // Mission Center's prefix table: `en*` is Ethernet, `bridge*` a bridge.
  return kindFromName(i.id);
}

/** The port's name from System Settings, the VPN's own, or what the bridge is for. */
export function darwinNicDeviceName(i: DarwinInterface, port: string | undefined): string | undefined {
  return port ?? i.vpnName ?? (i.description === NETWORK_SHARING ? SHARING_NAME : undefined);
}

export function buildDarwinNicInventory(
  ifaces: ReadonlyMap<string, DarwinInterface>,
  services: ReadonlyMap<string, string> | undefined,
  addresses: AddressMap,
): NicInfo[] {
  return listDarwinInterfaces(ifaces, services).map((id) => {
    const iface = ifaces.get(id)!;
    const port = services?.get(id);
    const deviceName = darwinNicDeviceName(iface, port);
    return {
      id,
      kind: darwinNicKind(iface, port),
      ...(deviceName ? { deviceName } : {}),
      ...(iface.mac ? { mac: iface.mac } : {}),
      ipv4: addresses[id]?.ipv4 ?? [],
      ipv6: addresses[id]?.ipv6 ?? [],
    };
  });
}

export async function readDarwinNicInventory(
  reads: DarwinToolReads,
  addresses: () => AddressMap = readAddresses,
): Promise<NicInfo[]> {
  const [ifconfig, services] = await Promise.all([reads.ifconfig(), reads.serviceOrder()]);
  if (!ifconfig) return [];
  return buildDarwinNicInventory(
    parseIfconfig(ifconfig.value),
    services ? parseServiceOrder(services.value) : undefined,
    addresses(),
  );
}
