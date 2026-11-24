import { connect, type Socket } from "node:net";

/** The SOCKS5 wire format (RFC 1928) the egress proxy speaks: CONNECT requests and replies. */

export const REP_GENERAL = 0x01;
export const REP_NOT_ALLOWED = 0x02;
export const REP_HOST_UNREACHABLE = 0x04;
export const REP_REFUSED = 0x05;
export const REP_COMMAND = 0x07;
export const REP_ADDRESS_TYPE = 0x08;

/** A reply with an all-zero bound address: Chrome does not read it. */
export const socksReply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

export type ConnectRequest = { host: string; port: number; domain: boolean; rest: Buffer };

/** The CONNECT request at the head of `buf`: null while incomplete, a reply code when unusable. */
export function parseConnectRequest(buf: Buffer): ConnectRequest | number | null {
  if (buf.length < 5) return null;
  if (buf[0] !== 5) return REP_GENERAL;
  if (buf[1] !== 1) return REP_COMMAND;
  const atyp = buf[3];
  const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + (buf[4] ?? 0) : -1;
  if (addrLen < 0) return REP_ADDRESS_TYPE;
  const end = 4 + addrLen + 2;
  if (buf.length < end) return null;
  const raw = buf.subarray(4, 4 + addrLen);
  let host: string;
  if (atyp === 1) host = [...raw].join(".");
  else if (atyp === 4) host = Array.from({ length: 8 }, (_, i) => raw.readUInt16BE(i * 2).toString(16)).join(":");
  else host = raw.subarray(1).toString("latin1");
  return { host, port: buf.readUInt16BE(end - 2), domain: atyp === 3, rest: Buffer.from(buf.subarray(end)) };
}

/** A TCP connection to `ip`, or the SOCKS reply code saying why there is none. */
export function dialAddress(ip: string, port: number, timeoutMs: number): Promise<Socket | number> {
  return new Promise((done) => {
    const up = connect({ host: ip, port });
    const timer = setTimeout(() => { up.destroy(); done(REP_HOST_UNREACHABLE); }, timeoutMs);
    up.once("connect", () => { clearTimeout(timer); done(up); });
    up.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      up.destroy();
      done(e.code === "ECONNREFUSED" ? REP_REFUSED : REP_HOST_UNREACHABLE);
    });
  });
}
