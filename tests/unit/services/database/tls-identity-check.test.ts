/**
 * The certificate name check Bun skips when `tls.connect` has no `servername`, put back. What is
 * pinned: a certificate for another name is refused from a server named by IP address — over a
 * socket too, which is how both drivers connect — before anything is written to it; the socket's
 * `_host` names the server when it has one, as in Node; and what Bun already checks, or was told
 * not to, is left alone.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import net from "node:net";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { identityHost, installTlsIdentityCheck, needsIdentityCheck } from "../../../../src/services/database/tls-identity-check.ts";
import { FOO_CERT, FOO_KEY, IP_CERT, IP_KEY, TEST_CA } from "../../../fixtures/tls-identity-certs.ts";

interface TestServer {
  port: number;
  /** Bytes of application data received, over every connection. */
  received(): number;
  close(): void;
}

async function serve(cert: string, key: string): Promise<TestServer> {
  let received = 0;
  const server = tls.createServer({ cert, key }, (socket) => {
    socket.on("data", (data: Buffer) => { received += data.length; });
    socket.on("error", () => { /* a client that gave up */ });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, received: () => received, close: () => server.close() };
}

type Outcome = { ok: true } | { ok: false; code: string };

/** Connects and, the moment the connection says it is secure, writes what a driver would: the login. */
function connect(options: tls.ConnectionOptions): Promise<Outcome> {
  return new Promise((resolve) => {
    const socket = tls.connect({ ca: TEST_CA, ...options }, () => {
      socket.write("password");
      resolve({ ok: true });
      socket.end();
    });
    socket.once("error", (e: NodeJS.ErrnoException) => resolve({ ok: false, code: e.code ?? e.message }));
  });
}

async function tcp(port: number): Promise<net.Socket> {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  return socket;
}

/** A socket that is not a net.Socket, as the SSH tunnel's channel is, naming its server in `_host`. */
class Channel extends Duplex {
  readonly _host: string;
  private readonly inner: net.Socket;

  constructor(inner: net.Socket, host: string) {
    super();
    this.inner = inner;
    this._host = host;
    inner.on("data", (data: Buffer) => this.push(data));
    inner.on("end", () => this.push(null));
    inner.on("error", (e) => this.destroy(e));
  }

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.inner.write(chunk, cb);
  }

  override _final(cb: () => void): void {
    this.inner.end();
    cb();
  }

  override _destroy(e: Error | null, cb: (e?: Error | null) => void): void {
    this.inner.destroy();
    cb(e);
  }
}

const REFUSED: Outcome = { ok: false, code: "ERR_TLS_CERT_ALTNAME_INVALID" };
let foo: TestServer;
let byAddress: TestServer;

beforeAll(async () => {
  installTlsIdentityCheck();
  foo = await serve(FOO_CERT, FOO_KEY);
  byAddress = await serve(IP_CERT, IP_KEY);
});

afterAll(() => {
  foo.close();
  byAddress.close();
});

describe("a server named by IP address", () => {
  it("is refused a certificate for another name, before anything is written to it", async () => {
    expect(await connect({ host: "127.0.0.1", port: foo.port })).toEqual(REFUSED);
    expect(await connect({ socket: await tcp(foo.port) })).toEqual(REFUSED);
    await Bun.sleep(50);
    expect(foo.received()).toBe(0);
  });

  it("gets through with a certificate that names its address", async () => {
    expect(await connect({ host: "127.0.0.1", port: byAddress.port })).toEqual({ ok: true });
    expect(await connect({ socket: await tcp(byAddress.port) })).toEqual({ ok: true });
  });

  it("is the one the socket's _host names, when it has one", async () => {
    expect(await connect({ socket: new Channel(await tcp(foo.port), "foo") })).toEqual({ ok: true });
    expect(await connect({ socket: new Channel(await tcp(foo.port), "bar") })).toEqual(REFUSED);
    expect(await connect({ socket: new Channel(await tcp(byAddress.port), "127.0.0.1") })).toEqual({ ok: true });
  });
});

describe("left to Bun", () => {
  it("a connection with a servername, which Bun checks itself", async () => {
    expect(await connect({ host: "127.0.0.1", port: foo.port, servername: "foo" })).toEqual({ ok: true });
    expect(await connect({ host: "127.0.0.1", port: foo.port, servername: "bar" })).toEqual(REFUSED);
  });

  it("a connection told not to check, and a check that asks nothing of the name (verify-ca)", async () => {
    expect(await connect({ host: "127.0.0.1", port: foo.port, rejectUnauthorized: false })).toEqual({ ok: true });
    expect(await connect({ host: "127.0.0.1", port: foo.port, checkServerIdentity: () => undefined })).toEqual({ ok: true });
    // A check of its own is given the name, and has the last word.
    expect(await connect({ host: "127.0.0.1", port: foo.port, checkServerIdentity: (_name, cert) => tls.checkServerIdentity("foo", cert) })).toEqual({ ok: true });
  });
});

describe("the name checked", () => {
  it("is host, then the socket's _host, then its address, then localhost", () => {
    expect(identityHost({ host: "db", socket: { _host: "x", remoteAddress: "10.0.0.5" } })).toBe("db");
    expect(identityHost({ socket: { _host: "x", remoteAddress: "10.0.0.5" } })).toBe("x");
    expect(identityHost({ socket: { remoteAddress: "10.0.0.5" } })).toBe("10.0.0.5");
    expect(identityHost({ host: "", socket: null })).toBe("localhost");
  });

  it("is checked only where Node checks it and Bun does not", () => {
    expect(needsIdentityCheck({})).toBe(true);
    expect(needsIdentityCheck({ servername: "" })).toBe(true);
    expect(needsIdentityCheck({ rejectUnauthorized: undefined })).toBe(true);
    expect(needsIdentityCheck({ servername: "db" })).toBe(false);
    expect(needsIdentityCheck({ rejectUnauthorized: false })).toBe(false);
  });
});
