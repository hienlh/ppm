import { connect, type Socket } from "node:net";

/** A minimal SOCKS5 client for tests: greets, sends one CONNECT, returns the reply code. */

export interface SocksAttempt {
  /** The REP byte, or "no-auth-refused" when the server answered the greeting with 0xFF. */
  code: number | "no-auth-refused";
  socket: Socket;
}

export type SocksTarget = { domain: string; port: number } | { ipv4: string; port: number } | { ipv6Bytes: number[]; port: number };

function requestBytes(target: SocksTarget, command = 1): Buffer {
  const port = Buffer.alloc(2);
  port.writeUInt16BE(target.port);
  if ("domain" in target) {
    const name = Buffer.from(target.domain, "latin1");
    return Buffer.concat([Buffer.from([5, command, 0, 3, name.length]), name, port]);
  }
  if ("ipv4" in target) return Buffer.concat([Buffer.from([5, command, 0, 1, ...target.ipv4.split(".").map(Number)]), port]);
  return Buffer.concat([Buffer.from([5, command, 0, 4, ...target.ipv6Bytes]), port]);
}

/** Reads exactly `n` bytes; leftover bytes are pushed back onto the socket. */
function readBytes(socket: Socket, n: number, timeoutMs = 5000): Promise<Buffer> {
  return new Promise((ok, fail) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); fail(new Error(`timed out waiting for ${n} bytes`)); }, timeoutMs);
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= n) {
        cleanup();
        socket.pause();
        if (buf.length > n) socket.unshift(buf.subarray(n));
        ok(buf.subarray(0, n));
      }
    };
    const onEnd = () => { cleanup(); fail(new Error(`socket closed after ${buf.length}/${n} bytes`)); };
    const cleanup = () => { clearTimeout(timer); socket.off("data", onData); socket.off("close", onEnd); };
    socket.on("data", onData);
    socket.on("close", onEnd);
    socket.resume();
  });
}

export async function socksConnect(proxyPort: number, target: SocksTarget, opts: { methods?: number[]; command?: number } = {}): Promise<SocksAttempt> {
  const socket = connect({ host: "127.0.0.1", port: proxyPort });
  socket.on("error", () => {});
  await new Promise<void>((ok, fail) => { socket.once("connect", () => ok()); socket.once("error", fail); });
  const methods = opts.methods ?? [0];
  socket.write(Buffer.from([5, methods.length, ...methods]));
  const greeting = await readBytes(socket, 2);
  if (greeting[1] === 0xff) return { code: "no-auth-refused", socket };
  socket.write(requestBytes(target, opts.command));
  const reply = await readBytes(socket, 10);
  return { code: reply[1] ?? -1, socket };
}

/** Sends `data` and collects everything the far end sends until it closes or `timeoutMs` passes. */
export function exchange(socket: Socket, data: string, timeoutMs = 3000): Promise<string> {
  return new Promise((ok) => {
    let got = "";
    const finish = () => { clearTimeout(timer); ok(got); };
    const timer = setTimeout(finish, timeoutMs);
    socket.on("data", (c: Buffer) => { got += c.toString("latin1"); });
    socket.once("close", finish);
    socket.resume();
    socket.write(data);
  });
}
