import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import {
  EGRESS_CANARY_HOST, startSocks5Server, type EgressBlockedEvent, type EgressPolicy, type Socks5Server,
} from "../../../../src/services/web-browser/egress/socks5-server.ts";
import { exchange, socksConnect } from "../../../helpers/socks5-test-client.ts";

/** A loopback echo server standing in for a local dev server. */
let echo: Server;
let echoPort = 0;
const open: Socket[] = [];

beforeAll(async () => {
  echo = createServer((s) => { s.on("error", () => {}); s.pipe(s); });
  echoPort = await new Promise<number>((ok) => echo.listen(0, "127.0.0.1", () => ok((echo.address() as { port: number }).port)));
});
afterAll(() => new Promise<void>((ok) => echo.close(() => ok())));

let proxy: Socks5Server | null = null;
afterEach(async () => {
  for (const s of open.splice(0)) s.destroy();
  await proxy?.close();
  proxy = null;
});

interface Setup {
  policy?: Partial<EgressPolicy>;
  names?: Record<string, string[]>;
  maxConnections?: number;
  handshakeTimeoutMs?: number;
}

async function start(setup: Setup = {}) {
  const blocked: EgressBlockedEvent[] = [];
  const lookups: string[] = [];
  let canaries = 0;
  proxy = await startSocks5Server({
    policy: () => ({ allowLocalhost: true, allowLan: true, blockedLocalPorts: [], ...setup.policy }),
    onBlocked: (e) => blocked.push(e),
    onCanary: () => { canaries++; },
    resolve: async (host) => {
      lookups.push(host);
      const answer = setup.names?.[host];
      if (!answer) throw new Error("ENOTFOUND");
      return answer;
    },
    localNetwork: () => ({ ownAddresses: ["127.0.0.1", "::1", "192.168.1.50"] }),
    maxConnections: setup.maxConnections,
    handshakeTimeoutMs: setup.handshakeTimeoutMs,
  });
  return { port: proxy.port, blocked, lookups, canaries: () => canaries };
}

async function attempt(port: number, target: Parameters<typeof socksConnect>[1], opts?: Parameters<typeof socksConnect>[2]) {
  const result = await socksConnect(port, target, opts);
  open.push(result.socket);
  return result;
}

describe("SOCKS5 egress proxy", () => {
  it("relays to a loopback server when localhost is allowed", async () => {
    const p = await start();
    const r = await attempt(p.port, { ipv4: "127.0.0.1", port: echoPort });
    expect(r.code).toBe(0);
    expect(await exchange(r.socket, "hello", 500)).toBe("hello");
  });

  it("refuses a loopback port in blockedLocalPorts", async () => {
    const p = await start({ policy: { blockedLocalPorts: [echoPort] } });
    const r = await attempt(p.port, { ipv4: "127.0.0.1", port: echoPort });
    expect(r.code).toBe(2);
    expect(p.blocked).toEqual([{ host: "127.0.0.1", port: echoPort, reason: "own-port" }]);
  });

  it("refuses PPM's own public host names by name, before resolving them", async () => {
    const p = await start({ policy: { blockedHostNames: ["ppm.example.com"] }, names: { "ppm.example.com": ["203.0.113.9"] } });
    const r = await attempt(p.port, { domain: "PPM.Example.com.", port: 443 });
    expect(r.code).toBe(2);
    expect(p.blocked[0]?.reason).toBe("own-port");
    expect(p.lookups).toEqual([]);
  });

  it("refuses this machine's LAN address on a blocked port without dialling it", async () => {
    const p = await start({ policy: { blockedLocalPorts: [8080] } });
    const r = await attempt(p.port, { ipv4: "192.168.1.50", port: 8080 });
    expect(r.code).toBe(2);
    expect(p.blocked[0]?.reason).toBe("own-port");
  });

  it("refuses loopback when localhost is off", async () => {
    const p = await start({ policy: { allowLocalhost: false } });
    const r = await attempt(p.port, { domain: "localhost", port: echoPort });
    expect(p.lookups).toEqual(["localhost"]);
    expect(r.code).toBe(4); // the fake resolver knows no "localhost": a DNS failure
    const r2 = await attempt(p.port, { ipv4: "127.0.0.1", port: echoPort });
    expect(r2.code).toBe(2);
    expect(p.blocked.at(-1)?.reason).toBe("private-address");
  });

  it("resolves a local name once and connects to the address it checked", async () => {
    const p = await start({ names: { "devbox.local": ["127.0.0.1"] } });
    const r = await attempt(p.port, { domain: "devbox.local", port: echoPort });
    expect(r.code).toBe(0);
    expect(await exchange(r.socket, "ping", 500)).toBe("ping");
    expect(p.lookups).toEqual(["devbox.local"]);
  });

  it("lets local names reach this machine and the LAN: a single label, .local, .lan, .home.arpa, .internal, .ts.net", async () => {
    const names = { nas: ["127.0.0.1"], "nas.lan": ["127.0.0.1"], "printer.home.arpa": ["127.0.0.1"], "svc.internal": ["127.0.0.1"], "ppm.tail1.ts.net": ["127.0.0.1"] };
    const p = await start({ names });
    for (const domain of Object.keys(names)) {
      const r = await attempt(p.port, { domain, port: echoPort });
      expect([domain, r.code]).toEqual([domain, 0]);
    }
  });

  it("refuses a public name that answers with this machine or a LAN address (DNS rebinding)", async () => {
    const p = await start({ names: { "evil.example": ["192.168.1.1"], "evil2.example": ["127.0.0.1"] } });
    expect((await attempt(p.port, { domain: "evil.example", port: 80 })).code).toBe(2);
    expect((await attempt(p.port, { domain: "evil2.example", port: echoPort })).code).toBe(2);
    expect(p.blocked.map((b) => b.reason)).toEqual(["public-name-inward", "public-name-inward"]);
    // Typed as an IP, the same LAN address stays open: the user's choice.
    expect((await attempt(p.port, { ipv4: "127.0.0.1", port: echoPort })).code).toBe(0);
  });

  it("checks every connection, so a public name that switches its answer inward is refused then", async () => {
    let calls = 0;
    proxy = await startSocks5Server({
      policy: () => ({ allowLocalhost: true, allowLan: true, blockedLocalPorts: [] }),
      onBlocked: () => {},
      onCanary: () => {},
      resolve: async () => (++calls === 1 ? ["203.0.113.10"] : ["127.0.0.1"]),
      localNetwork: () => ({ ownAddresses: ["127.0.0.1"] }),
      handshakeTimeoutMs: 300,
    });
    // Allowed by policy; 203.0.113.10 is unreachable here, so the dial itself fails or times out.
    const first = await attempt(proxy.port, { domain: "flip.example", port: echoPort }).catch(() => null);
    expect(first?.code).not.toBe(2);
    const second = await attempt(proxy.port, { domain: "flip.example", port: echoPort });
    expect(second.code).toBe(2);
  });

  it("refuses a name when any of its answers points inward (rebinding)", async () => {
    const p = await start({ policy: { allowLan: false }, names: { "rebind.test": ["93.184.216.34", "10.0.0.5"] } });
    const r = await attempt(p.port, { domain: "rebind.test", port: 80 });
    expect(r.code).toBe(2);
    expect(p.blocked).toEqual([{ host: "rebind.test", port: 80, reason: "private-address" }]);
  });

  it("refuses metadata names before resolving them and metadata answers after", async () => {
    const p = await start({ names: { "evil.test": ["169.254.169.254"] } });
    expect((await attempt(p.port, { domain: "metadata.google.internal", port: 80 })).code).toBe(2);
    expect(p.lookups).toEqual([]);
    expect((await attempt(p.port, { domain: "evil.test", port: 80 })).code).toBe(2);
    expect((await attempt(p.port, { ipv4: "169.254.169.254", port: 80 })).code).toBe(2);
    expect(p.blocked.map((b) => b.reason)).toEqual(["metadata", "metadata", "metadata"]);
  });

  it("reports a name that does not resolve as host unreachable", async () => {
    const p = await start();
    const r = await attempt(p.port, { domain: "nowhere.test", port: 443 });
    expect(r.code).toBe(4);
    expect(p.blocked).toEqual([{ host: "nowhere.test", port: 443, reason: "dns-failed" }]);
  });

  it("parses IPv6 targets", async () => {
    const p = await start({ policy: { allowLan: false } });
    const linkLocal = [0xfe, 0x80, ...Array(13).fill(0), 1];
    const r = await attempt(p.port, { ipv6Bytes: linkLocal, port: 80 });
    expect(r.code).toBe(2);
    expect(p.blocked[0]?.host).toBe("fe80:0:0:0:0:0:0:1");
  });

  it("answers the canary with a 204 and reports it", async () => {
    const p = await start();
    const r = await attempt(p.port, { domain: EGRESS_CANARY_HOST, port: 80 });
    expect(r.code).toBe(0);
    const answer = await exchange(r.socket, `GET / HTTP/1.1\r\nHost: ${EGRESS_CANARY_HOST}\r\n\r\n`);
    expect(answer.startsWith("HTTP/1.1 204")).toBe(true);
    expect(p.canaries()).toBe(1);
    expect(p.lookups).toEqual([]);
  });

  it("refuses clients that offer no unauthenticated method, and commands other than CONNECT", async () => {
    const p = await start();
    expect((await attempt(p.port, { ipv4: "127.0.0.1", port: echoPort }, { methods: [2] })).code).toBe("no-auth-refused");
    expect((await attempt(p.port, { ipv4: "127.0.0.1", port: echoPort }, { command: 2 })).code).toBe(7);
  });

  it("drops connections over the limit and idle handshakes", async () => {
    const p = await start({ maxConnections: 1, handshakeTimeoutMs: 200 });
    const first = await attempt(p.port, { ipv4: "127.0.0.1", port: echoPort });
    expect(first.code).toBe(0);
    await expect(socksConnect(p.port, { ipv4: "127.0.0.1", port: echoPort })).rejects.toThrow();
    first.socket.destroy();
    await Bun.sleep(50);
    const { connect } = await import("node:net");
    const idle = connect({ host: "127.0.0.1", port: p.port });
    idle.on("error", () => {});
    open.push(idle);
    const closed = await Promise.race([new Promise((ok) => idle.once("close", () => ok(true))), Bun.sleep(2000).then(() => false)]);
    expect(closed).toBe(true);
  });
});
