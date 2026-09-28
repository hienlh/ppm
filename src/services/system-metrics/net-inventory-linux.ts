/**
 * Static facts about each network interface: what kind it is, the adapter's
 * marketing name, its driver, MAC and addresses.
 *
 * Mission Center classifies by NetworkManager's device type and falls back to a
 * table of name prefixes — and its type read always fails (it asks for a u64
 * where NM publishes a u32), so in practice the prefix table is all that ever
 * runs. PPM asks sysfs and udev first, which are exact, and keeps that same
 * prefix table only as the last resort.
 */
import { networkInterfaces } from "node:os";
import type { NicInfo, NicKind } from "../../types/system-hardware.ts";
import { readAttr, readNumber, realLinuxFs, type LinuxFs } from "./linux-fs.ts";
import { readUdevProperties, udevValue } from "./udev-db.ts";
import { listNetInterfaces, SYS_NET } from "./net-devices-linux.ts";

const ARPHRD_INFINIBAND = 32;
/** `tun_flags` bit 0: a TUN (layer 3) device, i.e. a tunnel rather than a tap. */
const IFF_TUN = 0x1;

export function readNicInventory(
  fs: LinuxFs = realLinuxFs,
  addresses: () => AddressMap = readAddresses,
): NicInfo[] {
  const addrs = addresses();
  return listNetInterfaces(fs).map((id) => readNicInfo(id, fs, addrs[id]));
}

export function readNicInfo(id: string, fs: LinuxFs, addr: Addresses | undefined): NicInfo {
  const udev = readUdevProperties(`n${readAttr(fs, `${SYS_NET}/${id}/ifindex`) ?? ""}`, fs.read);
  const driver = udevValue(udev, "ID_NET_DRIVER")
    ?? basename(fs.readlink(`${SYS_NET}/${id}/device/driver`) ?? "");

  return {
    id,
    kind: nicKind(id, fs),
    ...optional("deviceName", udevValue(udev, "ID_MODEL_FROM_DATABASE")),
    ...optional("driver", driver || undefined),
    ...optional("mac", readAttr(fs, `${SYS_NET}/${id}/address`)),
    ipv4: addr?.ipv4 ?? [],
    ipv6: addr?.ipv6 ?? [],
  };
}

/** sysfs facts first, Mission Center's prefix table only when none of them apply. */
export function nicKind(id: string, fs: Pick<LinuxFs, "read" | "exists">): NicKind {
  const devtype = uevent(fs, id).get("DEVTYPE");
  if (devtype === "wireguard") return "vpn";
  if (devtype === "wlan" || fs.exists(`${SYS_NET}/${id}/wireless`)) return "wireless";
  if (readNumber(fs, `${SYS_NET}/${id}/type`) === ARPHRD_INFINIBAND) return "infiniband";
  if (devtype === "bridge") return id.startsWith("docker") ? "docker" : "bridge";
  // A TUN device is a tunnel by construction — Mission Center has no rule for
  // these and files every one of them (tailscale0, tun0, nordlynx) under "other".
  const tunFlags = readAttr(fs, `${SYS_NET}/${id}/tun_flags`);
  if (tunFlags && (Number.parseInt(tunFlags, 16) & IFF_TUN) !== 0) return "vpn";
  return kindFromName(id);
}

/** Mission Center's `connection_kind_from_name`, order included. */
export function kindFromName(id: string): NicKind {
  if (id.startsWith("bn")) return "bluetooth";
  if (id.startsWith("br") || id.startsWith("virbr")) return "bridge";
  if (id.startsWith("docker")) return "docker";
  if (id.startsWith("eth") || id.startsWith("en")) return "wired";
  if (id.startsWith("ib")) return "infiniband";
  if (id.startsWith("mp")) return "multipass";
  if (id.startsWith("veth")) return "virtual";
  if (id.startsWith("vpn") || id.startsWith("wg")) return "vpn";
  if (id.startsWith("wl") || id.startsWith("ww")) return "wireless";
  return "other";
}

function uevent(fs: Pick<LinuxFs, "read">, id: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of (fs.read(`${SYS_NET}/${id}/uevent`) ?? "").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  return props;
}

export interface Addresses { ipv4: string[]; ipv6: string[] }
export type AddressMap = Record<string, Addresses>;

export function readAddresses(): AddressMap {
  const map: AddressMap = {};
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      const entry = (map[name] ??= { ipv4: [], ipv6: [] });
      (a.family === "IPv4" ? entry.ipv4 : entry.ipv6).push(a.address);
    }
  }
  return map;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
