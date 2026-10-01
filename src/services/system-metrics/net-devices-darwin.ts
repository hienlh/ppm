/**
 * Per-interface figures on macOS: byte counters from `netstat -ib`, link state and
 * speed from `ifconfig -a -v`, and which interfaces to show from the network
 * services System Settings lists.
 *
 * Linux lists every interface but loopback, and on Linux that is a short list. A
 * Mac has thirty-odd, and most are the system's own plumbing: AirDrop's `awdl0`
 * and `llw0`, the hotspot's `ap1`, `anpi*` and `en4`–`en6` behind the USB-C
 * ports, a `utun` per iCloud and Continuity agent, the Thunderbolt ports that only
 * exist as members of the Thunderbolt Bridge, and a `vmenet` per VM whose traffic
 * is already counted on the bridge it belongs to. So the page lists what a Mac
 * user would recognise: every network service's interface (Wi-Fi, each Ethernet
 * adapter, Thunderbolt Bridge, iPhone USB), every VPN tunnel, and each VM
 * network's bridge.
 */
import type { NicMetrics, NicState } from "../../types/system-metrics.ts";
import { toNicMetrics, type NicDeviceCollection, type NicSample, type NicSampleState } from "./net-devices-linux.ts";
import { wirelessFacts, type DarwinWifiStatus } from "./wifi-darwin.ts";

/** Marks the bridge a VM's shared network sits on (Virtualization.framework's
 *  NAT, Internet Sharing), in the bridge's own `desc:` line. */
export const NETWORK_SHARING = "com.apple.NetworkSharing";

/** The Wi-Fi chip's companions and the VM side of a sharing bridge — only used
 *  when the service list is unavailable and a hardware type is all there is. */
const COMPANION = /^(?:awdl|llw|ap|anpi|vmenet)\d/;

export interface DarwinInterface {
  id: string;
  /** `flags=8863<UP,BROADCAST,…>` */
  flags: string[];
  /** `xflags=10004<NOAUTONX,IS_VPN>` */
  xflags: string[];
  /** `status:` — absent on tunnels, which print none. */
  status?: "active" | "inactive";
  /** `type:` — "Wi-Fi", "Ethernet", "USB Ethernet", "IP over Thunderbolt". */
  type?: string;
  mac?: string;
  /** Mbit/s, from `link rate:` or else the maximum in `downlink rate:`. */
  linkMbps?: number;
  /** A VPN's own name, from its NetworkExtension agent: `desc:"VPN: <name>"`. */
  vpnName?: string;
  /** A bare `desc:` line, which is how a sharing bridge says what it is. */
  description?: string;
  /** A bridge's `member:` interfaces. */
  members: string[];
}

/** ifconfig prints rates as `%.2f <unit>`. */
const RATE_UNITS: Record<string, number> = { "": 1e-6, K: 1e-3, M: 1, G: 1e3, T: 1e6 };

function rateMbps(value: string, unit: string): number | undefined {
  const n = Number(value) * (RATE_UNITS[unit] ?? Number.NaN);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
}

export function parseIfconfig(text: string): Map<string, DarwinInterface> {
  const out = new Map<string, DarwinInterface>();
  let current: DarwinInterface | null = null;
  for (const raw of text.split("\n")) {
    const header = /^(\S+): flags=[0-9a-fA-F]+<([^>]*)>/.exec(raw);
    if (header) {
      current = { id: header[1]!, flags: list(header[2]!), xflags: [], members: [] };
      out.set(current.id, current);
      continue;
    }
    if (!current || !/^\s/.test(raw)) continue;
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^xflags=[0-9a-fA-F]+<([^>]*)>/.exec(line))) current.xflags = list(m[1]!);
    else if ((m = /^ether ([0-9a-fA-F:]{11,17})$/.exec(line))) current.mac = m[1]!.toLowerCase();
    else if ((m = /^status: (active|inactive)$/.exec(line))) current.status = m[1] as "active" | "inactive";
    else if ((m = /^type: (.+)$/.exec(line))) current.type = m[1]!.trim();
    else if ((m = /^link rate: ([\d.]+) ([KMGT]?)bps/.exec(line))) current.linkMbps = rateMbps(m[1]!, m[2]!);
    // Asymmetric links (Wi-Fi) print both directions, each "eff / max".
    else if ((m = /^downlink rate: .* \/ ([\d.]+) ([KMGT]?)bps/.exec(line))) current.linkMbps ??= rateMbps(m[1]!, m[2]!);
    else if ((m = /^member: (\S+)/.exec(line))) current.members.push(m[1]!);
    else if ((m = /^desc: (.+)$/.exec(line))) current.description = m[1]!.trim();
    if ((m = /desc:"VPN: ([^"]+)"/.exec(line))) current.vpnName = m[1]!.trim();
  }
  return out;
}

/**
 * `networksetup -listnetworkserviceorder`, as device → hardware port name. A
 * service with no device (a VPN, a proxy) is skipped: its tunnel is found by its
 * own flags instead, because it is only created while the VPN is connected.
 */
export function parseServiceOrder(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/\(Hardware Port: ([^,]*), Device: ([^)]*)\)/g)) {
    const port = m[1]!.trim();
    const device = m[2]!.trim();
    if (device && !out.has(device)) out.set(device, port);
  }
  return out;
}

/**
 * Every `<Link#N>` row of `netstat -ib`, by interface. A down interface is
 * printed with a trailing `*` ("gif0*"), which is not part of its name. The
 * other rows repeat the same counters once per address, so only the link row is
 * read; the Address column is blank on a tunnel, so the byte columns are counted
 * from the right.
 */
export function parseNetstatLinks(text: string): Map<string, { rx: number; tx: number }> {
  const out = new Map<string, { rx: number; tx: number }>();
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !(f[2] ?? "").startsWith("<Link#")) continue;
    const id = f[0]!.replace(/\*$/, "");
    const rx = Number(f[f.length - 5]);
    const tx = Number(f[f.length - 2]);
    if (!out.has(id) && Number.isFinite(rx) && Number.isFinite(tx)) out.set(id, { rx, tx });
  }
  return out;
}

/** The whole-machine Network card: every interface but loopback, as on Linux. */
export function sumNetCounters(links: ReadonlyMap<string, { rx: number; tx: number }>): { inBytes: number; outBytes: number } | null {
  let inBytes = 0;
  let outBytes = 0;
  let matched = false;
  for (const [id, { rx, tx }] of links) {
    if (/^lo\d/.test(id)) continue;
    matched = true;
    inBytes += rx;
    outBytes += tx;
  }
  return matched ? { inBytes, outBytes } : null;
}

function isListed(i: DarwinInterface, services: ReadonlyMap<string, string> | undefined): boolean {
  if (i.flags.includes("LOOPBACK")) return false;
  if (i.xflags.includes("IS_VPN")) return true;
  if (i.description === NETWORK_SHARING) return true;
  if (services) return services.has(i.id);
  // networksetup has never answered: an interface with a hardware type and a
  // link is real, the Wi-Fi chip's companions aside.
  return i.status === "active" && i.type !== undefined && !COMPANION.test(i.id);
}

/**
 * The interfaces to show, in System Settings' own order (the user's priority
 * order), then VPNs and VM bridges by name. The tick and the inventory both list
 * through here, so the inventory always knows every id a tick reports.
 */
export function listDarwinInterfaces(
  ifaces: ReadonlyMap<string, DarwinInterface>,
  services: ReadonlyMap<string, string> | undefined,
): string[] {
  const order = [...(services?.keys() ?? [])];
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  return [...ifaces.values()]
    .filter((i) => isListed(i, services))
    .map((i) => i.id)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }));
}

/** A tunnel prints no `status:`, so there UP + RUNNING is the link. */
export function darwinNicState(i: DarwinInterface): NicState {
  if (i.status === "active") return "connected";
  if (i.status === "inactive") return "disconnected";
  if (!i.flags.includes("UP")) return "disconnected";
  return i.flags.includes("RUNNING") ? "connected" : "unknown";
}

export interface DarwinNicInput {
  links: ReadonlyMap<string, { rx: number; tx: number }>;
  /** When `netstat` ran, seconds. */
  atSec: number;
  ifaces: ReadonlyMap<string, DarwinInterface>;
  services: ReadonlyMap<string, string> | undefined;
  /** The Wi-Fi interface's live radio facts, when there is one. */
  wifi?: DarwinWifiStatus;
}

/** One tick's per-interface figures, each against its own previous sample. */
export function collectDarwinNicDevices(prev: NicSampleState, input: DarwinNicInput): NicDeviceCollection {
  const next: NicSampleState = new Map();
  const nics: NicMetrics[] = [];
  for (const id of listDarwinInterfaces(input.ifaces, input.services)) {
    const counters = input.links.get(id);
    const iface = input.ifaces.get(id);
    if (!counters || !iface) continue;
    const sample: NicSample = { atSec: input.atSec, rx: counters.rx, tx: counters.tx };
    next.set(id, sample);
    const radio = input.wifi?.interfaceName === id ? wirelessFacts(input.wifi) : {};
    // The radio's own transmit rate is the Wi-Fi link speed Linux reports; the
    // driver's figure in ifconfig is an estimate of capacity, kept as a fallback.
    const linkMbps = radio.linkMbps ?? iface.linkMbps;
    nics.push({
      ...toNicMetrics(id, prev.get(id) ?? null, sample),
      state: darwinNicState(iface),
      ...(linkMbps !== undefined ? { linkMbps } : {}),
      ...(radio.ssid !== undefined ? { ssid: radio.ssid } : {}),
      ...(radio.signalPercent !== undefined ? { signalPercent: radio.signalPercent } : {}),
      ...(radio.frequencyMHz !== undefined ? { frequencyMHz: radio.frequencyMHz } : {}),
    });
  }
  return { nics, next };
}

const list = (s: string) => s.split(",").map((f) => f.trim()).filter(Boolean);
