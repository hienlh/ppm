/**
 * Node's check of the name on a server's certificate, for a TLS connection given no `servername`,
 * which Bun skips.
 *
 * Bun checks the name only when `tls.connect` is handed a `servername`. Measured on 1.3.11 against
 * a certificate for `foo`: accepted from `host: "127.0.0.1"`, and even from `host: "localhost"`,
 * where Node refuses both with ERR_TLS_CERT_ALTNAME_INVALID. postgres.js and mysql2 pass a
 * `servername` for a host name and none for an IP address — RFC 6066 does not allow one — so
 * `sslmode=verify-full` and `ssl-mode=VERIFY_IDENTITY` checked the chain and nothing else whenever
 * a connection named its server by address, directly or through an SSH tunnel: any certificate the
 * CA had signed for any server was taken.
 *
 * This puts Node's check back for that case only, as Node does it: the name is the `host` option,
 * else the socket's `_host`, else `localhost` — with one addition, the socket's own address, since
 * Bun's `net.Socket` has no `_host` and the drivers pass their socket rather than a host. A
 * connection with a `servername` is left to Bun, which checks it.
 */
import tls from "node:tls";

interface ConnectOptions {
  host?: unknown;
  servername?: unknown;
  rejectUnauthorized?: unknown;
  checkServerIdentity?: unknown;
  socket?: { _host?: unknown; remoteAddress?: unknown } | null;
}

type IdentityCheck = (host: string, cert: tls.PeerCertificate) => Error | undefined;

/** The name the certificate must carry when there is no `servername`. */
export function identityHost(options: ConnectOptions): string {
  for (const name of [options.host, options.socket?._host, options.socket?.remoteAddress]) {
    if (typeof name === "string" && name) return name;
  }
  return "localhost";
}

/** Whether Node would check the name on this connection and Bun will not. */
export function needsIdentityCheck(options: ConnectOptions): boolean {
  return options.rejectUnauthorized !== false && !(typeof options.servername === "string" && options.servername);
}

/**
 * Hold `secureConnect` back until the name is checked, and end the connection with the error
 * instead when it is wrong, before whoever asked for it can send anything — a password included.
 * A resumed session was checked when it was first made, which is why Node skips it too.
 */
function guard(socket: tls.TLSSocket, options: ConnectOptions): void {
  const emit = socket.emit;
  socket.emit = function (this: tls.TLSSocket, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "secureConnect") {
      socket.emit = emit;
      if (!socket.isSessionReused()) {
        const check = (typeof options.checkServerIdentity === "function" ? options.checkServerIdentity : tls.checkServerIdentity) as IdentityCheck;
        const error = check(identityHost(options), socket.getPeerCertificate(true));
        if (error) {
          socket.authorized = false;
          socket.destroy(error);
          return false;
        }
      }
    }
    return emit.call(this, event, ...args);
  } as typeof socket.emit;
}

let installed = false;

/** Once per process, on Bun only; both drivers look `tls.connect` up when they call it. */
export function installTlsIdentityCheck(): void {
  if (installed || !process.versions.bun) return;
  installed = true;
  const connect = tls.connect;
  tls.connect = function (this: unknown, ...args: unknown[]): tls.TLSSocket {
    const socket = (connect as (...a: unknown[]) => tls.TLSSocket).apply(this, args);
    // Only `connect(options[, callback])`, the form both drivers use.
    const options = args[0];
    if (options !== null && typeof options === "object" && needsIdentityCheck(options as ConnectOptions)) guard(socket, options as ConnectOptions);
    return socket;
  } as typeof tls.connect;
}
