import { lookup } from "node:dns/promises";
import { createServer, isIP, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import {
  classifyAddress, isMetadataHostName, localNetworkFrom, worstVerdict,
  type EgressBlockReason, type LocalNetwork,
} from "../address-policy.ts";
import {
  dialAddress, parseConnectRequest, REP_HOST_UNREACHABLE, REP_NOT_ALLOWED, socksReply as reply,
  type ConnectRequest,
} from "./socks5-protocol.ts";

/**
 * The in-app browser's egress proxy: SOCKS5 (RFC 1928), CONNECT only, no authentication, on
 * 127.0.0.1. Chrome hands every name to the proxy, so this is where DNS happens: each answer is
 * checked by `address-policy.ts` and the connection goes to the very address that was checked.
 * One refused answer refuses the name, so a name that also points inward cannot be used to
 * reach the inside by luck of ordering.
 *
 * `ppm-egress-canary.invalid` never resolves anywhere; a CONNECT to it is answered here with a
 * 204, which proves Chrome is really routing through this proxy.
 */

export const EGRESS_CANARY_HOST = "ppm-egress-canary.invalid";

export interface EgressPolicy {
  allowLocalhost: boolean;
  allowLan: boolean;
  blockedLocalPorts: number[];
}

export interface EgressBlockedEvent {
  host: string;
  port: number;
  reason: EgressBlockReason;
}

export interface Socks5ServerOptions {
  policy: () => EgressPolicy;
  onBlocked: (event: EgressBlockedEvent) => void;
  onCanary: () => void;
  /** Test seam: every address a name resolves to. */
  resolve?: (host: string) => Promise<string[]>;
  /** Test seam: this machine's addresses. */
  localNetwork?: () => LocalNetwork;
  maxConnections?: number;
  /** From the first byte until the target is connected. */
  handshakeTimeoutMs?: number;
}

export interface Socks5Server {
  port: number;
  close(): Promise<void>;
}

const NETWORK_TTL_MS = 60_000;

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

export async function startSocks5Server(opts: Socks5ServerOptions): Promise<Socks5Server> {
  const resolve = opts.resolve ?? defaultResolve;
  const readNetwork = opts.localNetwork ?? (() => localNetworkFrom(networkInterfaces()));
  const max = opts.maxConnections ?? 256;
  const handshakeMs = opts.handshakeTimeoutMs ?? 15_000;
  const sockets = new Set<Socket>();
  let network = { at: 0, value: { ownAddresses: [] } as LocalNetwork };
  const currentNetwork = (): LocalNetwork => {
    if (Date.now() - network.at > NETWORK_TTL_MS) network = { at: Date.now(), value: readNetwork() };
    return network.value;
  };

  function canary(sock: Socket, rest: Buffer, done: () => void): void {
    let head = rest.toString("latin1");
    const finish = () => {
      sock.off("data", onData);
      done();
      sock.end("HTTP/1.1 204 No Content\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      opts.onCanary();
    };
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (head.includes("\r\n\r\n") || head.length > 8192) finish();
    };
    sock.write(reply(0));
    if (head.includes("\r\n\r\n")) return finish();
    sock.on("data", onData);
    sock.resume();
  }

  async function open(sock: Socket, req: ConnectRequest, done: () => void): Promise<void> {
    const { host, port } = req;
    if (req.domain && host.toLowerCase().replace(/\.+$/, "") === EGRESS_CANARY_HOST) return canary(sock, req.rest, done);
    const refuse = (reason: EgressBlockReason, code = REP_NOT_ALLOWED) => {
      opts.onBlocked({ host, port, reason });
      sock.end(reply(code));
    };
    if (req.domain && isMetadataHostName(host)) return refuse("metadata");
    let addresses: string[] = [];
    if (!req.domain || isIP(host)) addresses = [host];
    else {
      try { addresses = await resolve(host); } catch { addresses = []; }
      if (addresses.length === 0) return refuse("dns-failed", REP_HOST_UNREACHABLE);
    }
    if (sock.destroyed) return;
    const ctx = { ...opts.policy(), ...currentNetwork(), port };
    const verdict = worstVerdict(addresses.map((a) => classifyAddress(a, ctx)));
    if (!verdict.ok) return refuse(verdict.reason);
    let code = REP_HOST_UNREACHABLE;
    for (const address of addresses) {
      const up = await dialAddress(address, port, handshakeMs);
      if (typeof up === "number") { code = up; continue; }
      if (sock.destroyed) { up.destroy(); return; }
      done();
      up.on("error", () => sock.destroy());
      up.on("close", () => sock.destroy());
      sock.on("close", () => up.destroy());
      sock.write(reply(0));
      if (req.rest.length > 0) up.write(req.rest);
      sock.pipe(up);
      up.pipe(sock);
      sock.resume();
      return;
    }
    if (!sock.destroyed) sock.end(reply(code));
  }

  function handle(sock: Socket): void {
    if (sockets.size >= max) { sock.destroy(); return; }
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    let greeted = false;
    const timer = setTimeout(() => sock.destroy(), handshakeMs);
    const done = () => clearTimeout(timer);
    sock.on("error", () => sock.destroy());
    sock.on("close", () => { done(); sockets.delete(sock); });
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 1024) return void sock.destroy();
      if (!greeted) {
        if (buf.length < 2 || buf.length < 2 + (buf[1] ?? 0)) return;
        if (buf[0] !== 5) return void sock.destroy();
        const methods = buf.subarray(2, 2 + (buf[1] ?? 0));
        buf = buf.subarray(2 + methods.length);
        if (!methods.includes(0)) return void sock.end(Buffer.from([5, 0xff]));
        greeted = true;
        sock.write(Buffer.from([5, 0]));
      }
      const req = parseConnectRequest(buf);
      if (req === null) return;
      sock.off("data", onData);
      sock.pause();
      if (typeof req === "number") return void sock.end(reply(req));
      open(sock, req, done).catch(() => sock.destroy());
    };
    sock.on("data", onData);
  }

  const server = createServer(handle);
  server.on("error", () => {});
  const port = await new Promise<number>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") ok(address.port);
      else fail(new Error("SOCKS5 server has no port"));
    });
  });
  return {
    port,
    close: () => new Promise<void>((ok) => {
      for (const s of sockets) s.destroy();
      server.close(() => ok());
    }),
  };
}
