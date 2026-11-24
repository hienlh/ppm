import { isIP } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

/**
 * Which addresses the in-app browser's egress proxy may connect to. Pure: no DNS, no sockets.
 *
 * The proxy resolves a name itself, runs every resulting address through `classifyAddress`, and
 * then connects to exactly that address — so a name that answers differently on a second lookup
 * (DNS rebinding) gains nothing. Addresses fall into four bands:
 * - always refused: cloud metadata endpoints, `0/8` and `::`, multicast, reserved and broadcast;
 * - this machine (loopback and every address its interfaces hold): allowed with `allowLocalhost`,
 *   except the ports in `blockedLocalPorts` (PPM, its supervisor, edge and relays). PPM listens
 *   on 0.0.0.0, so `<LAN IP>:<PPM port>` reaches it just as `127.0.0.1` does;
 * - private and link-local networks, plus subnets this machine is on: allowed with `allowLan`;
 * - everything else: allowed.
 * IPv4 carried inside IPv6 (mapped, compatible, NAT64, 6to4, Teredo) is unwrapped and judged as
 * the IPv4 address it reaches.
 */

export type EgressBlockReason = "private-address" | "own-port" | "metadata" | "dns-failed" | "public-name-inward";
export type AddressVerdict = { ok: true } | { ok: false; reason: EgressBlockReason };

/** What `os.networkInterfaces()` says about this machine, refreshed by the caller. */
export interface LocalNetwork {
  ownAddresses: string[];
  /** Subnets this machine is on, as `addr/len` (each IPv6 global address's /64). */
  onLinkPrefixes?: string[];
  broadcastAddresses?: string[];
}

export interface AddressPolicyContext extends LocalNetwork {
  allowLocalhost: boolean;
  allowLan: boolean;
  blockedLocalPorts: number[];
  port: number;
}

/** Names of cloud metadata services, refused before any lookup. */
export const METADATA_HOST_NAMES = ["metadata.google.internal", "metadata", "metadata.azure.internal"];
const METADATA_IPS = ["169.254.169.254", "169.254.170.2", "169.254.169.253", "100.100.100.200", "fd00:ec2::254"];

type Ip = { v: 4; n: bigint } | { v: 6; n: bigint };
type Range = { v: 4 | 6; base: bigint; bits: number };

const OK: AddressVerdict = { ok: true };
const block = (reason: EgressBlockReason): AddressVerdict => ({ ok: false, reason });

function parseV4(s: string): bigint {
  return s.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

function parseV6(s: string): bigint {
  let text = s.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (dotted) {
    const v4 = parseV4(dotted);
    text = `${text.slice(0, -dotted.length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** Parses an address (scope id dropped); null for anything `net.isIP` rejects. */
export function parseIp(raw: string): Ip | null {
  const text = raw.split("%")[0] ?? "";
  const kind = isIP(text);
  if (kind === 4) return { v: 4, n: parseV4(text) };
  if (kind === 6) return { v: 6, n: parseV6(text) };
  return null;
}

function range(cidr: string): Range | null {
  const [addr, len] = cidr.split("/");
  const ip = addr ? parseIp(addr) : null;
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const bits = len === undefined ? max : Number(len);
  return Number.isInteger(bits) && bits >= 0 && bits <= max ? { v: ip.v, base: ip.n, bits } : null;
}

function inRange(ip: Ip, r: Range): boolean {
  if (ip.v !== r.v) return false;
  const shift = BigInt((ip.v === 4 ? 32 : 128) - r.bits);
  return ip.n >> shift === r.base >> shift;
}

const ranges = (list: string[]): Range[] => list.map(range).filter((r): r is Range => r !== null);
const ALWAYS = ranges(["0.0.0.0/8", "224.0.0.0/3", "::/128", "ff00::/8"]);
const LOOPBACK = ranges(["127.0.0.0/8", "::1/128"]);
const LAN = ranges([
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16",
  // Benchmarking range, also where fake-IP DNS proxies (Clash, Surge) map every name.
  "198.18.0.0/15", "fc00::/7", "fe80::/10",
]);
const METADATA = ranges(METADATA_IPS);

const same = (a: Ip, b: Ip | null) => b !== null && a.v === b.v && a.n === b.n;
const MASK32 = 0xffffffffn;

/** The IPv4 addresses an IPv6 address really reaches, or [] when it carries none. */
function embeddedV4(n: bigint): bigint[] {
  const top96 = n >> 32n;
  const low = n & MASK32;
  if (top96 === 0xffffn || top96 === 0n) return [low]; // ::ffff:a.b.c.d, ::a.b.c.d
  if (top96 === 0x64ff9b0000000000000000n) return [low]; // NAT64 64:ff9b::/96
  if (n >> 80n === 0x64ff9b0001n) return [low]; // local-use NAT64 64:ff9b:1::/48
  if (n >> 112n === 0x2002n) return [(n >> 80n) & MASK32]; // 6to4
  if (n >> 96n === 0x20010000n) return [(n >> 64n) & MASK32, low ^ MASK32]; // Teredo: server, client
  return [];
}

const RANK: Record<EgressBlockReason, number> = { metadata: 4, "own-port": 3, "public-name-inward": 2, "private-address": 1, "dns-failed": 0 };

/** The most telling of several refusals, so a metadata hit is never reported as a plain private one. */
export function worstVerdict(verdicts: AddressVerdict[]): AddressVerdict {
  let worst: AddressVerdict = OK;
  for (const v of verdicts) {
    if (!v.ok && (worst.ok || RANK[v.reason] > RANK[worst.reason])) worst = v;
  }
  return worst;
}

export function classifyAddress(ip: string, ctx: AddressPolicyContext): AddressVerdict {
  const parsed = parseIp(ip);
  if (!parsed) return block("private-address");
  if (parsed.v === 6 && parsed.n > 1n) {
    const inner = embeddedV4(parsed.n);
    if (inner.length > 0) return worstVerdict(inner.map((n) => classifyParsed({ v: 4, n }, ctx)));
  }
  return classifyParsed(parsed, ctx);
}

function classifyParsed(ip: Ip, ctx: AddressPolicyContext): AddressVerdict {
  if (METADATA.some((r) => inRange(ip, r))) return block("metadata");
  if (ALWAYS.some((r) => inRange(ip, r))) return block("private-address");
  if ((ctx.broadcastAddresses ?? []).some((b) => same(ip, parseIp(b)))) return block("private-address");
  if (LOOPBACK.some((r) => inRange(ip, r)) || ctx.ownAddresses.some((a) => same(ip, parseIp(a)))) {
    if (ctx.blockedLocalPorts.includes(ctx.port)) return block("own-port");
    return ctx.allowLocalhost ? OK : block("private-address");
  }
  const onLink = ranges(ctx.onLinkPrefixes ?? []);
  if (LAN.some((r) => inRange(ip, r)) || onLink.some((r) => inRange(ip, r))) {
    return ctx.allowLan ? OK : block("private-address");
  }
  return OK;
}

/**
 * Names that may lead into this machine or the home network: `localhost`, a single label (`nas`,
 * `router`), and the suffixes no public registry hands out (`.local`, `.lan`, `.home.arpa`,
 * `.internal`, `.localhost`) plus Tailscale's `*.ts.net`. Any other name is public, and a public
 * name answering with an inward address is DNS rebinding: a web page pointing its own name at
 * the router to read it. The user chose this rule over a list of allowed names (card 4ff0bb9c).
 */
export function isLocalName(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/\.+$/, "");
  if (!n) return false;
  if (!n.includes(".")) return true;
  return [".local", ".lan", ".home.arpa", ".internal", ".localhost", ".ts.net"].some((s) => n.endsWith(s));
}

/** Whether a requested name is a cloud metadata service's (case and a trailing dot ignored). */
export function isMetadataHostName(name: string): boolean {
  return METADATA_HOST_NAMES.includes(name.trim().toLowerCase().replace(/\.+$/, ""));
}

/**
 * This machine's addresses, subnets and broadcast addresses, from `os.networkInterfaces()`.
 * IPv4 subnets wider than /16 are left out: a VPN reporting a huge netmask would otherwise turn
 * the whole Internet into "the LAN".
 */
export function localNetworkFrom(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): LocalNetwork {
  const ownAddresses: string[] = [];
  const onLinkPrefixes: string[] = [];
  const broadcastAddresses: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      ownAddresses.push(info.address);
      if (info.internal) continue;
      const bits = Number(info.cidr?.split("/")[1]);
      if (info.family === "IPv4" && Number.isInteger(bits) && bits >= 16 && bits < 32) {
        onLinkPrefixes.push(`${info.address}/${bits}`);
        if (bits <= 30) {
          const n = parseV4(info.address) | (MASK32 >> BigInt(bits));
          broadcastAddresses.push([24n, 16n, 8n, 0n].map((s) => String((n >> s) & 0xffn)).join("."));
        }
      } else if (info.family === "IPv6" && !info.address.toLowerCase().startsWith("fe80")) {
        onLinkPrefixes.push(`${info.address}/64`);
      }
    }
  }
  return { ownAddresses, onLinkPrefixes, broadcastAddresses };
}
