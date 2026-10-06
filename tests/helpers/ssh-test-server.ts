/**
 * A real SSH server inside the test process: ssh2's own `Server`, from the repository's
 * devDependency. It logs in with a password, a public key or keyboard-interactive, and opens a
 * `direct-tcpip` channel the way OpenSSH does — connecting to the destination first, and refusing
 * the channel when that fails — so a tunnel can be driven end to end without docker.
 */
import net from "node:net";
// @ts-ignore — ssh2 ships no types; only the tests import it directly.
import { Server, utils } from "ssh2";

export interface SshTestServerOptions {
  user?: string;
  password?: string;
  /** An OpenSSH public key line allowed to log in. */
  publicKey?: string;
  /** Offer only keyboard-interactive, the way servers with PasswordAuthentication off do. */
  keyboardOnly?: boolean;
  /** Refuse every `direct-tcpip` channel, as `AllowTcpForwarding no` does. */
  forwarding?: boolean;
  /**
   * Answer no `direct-tcpip` channel until the test says so (`heldForwards`), as an SSH server
   * does while its own connect waits on a firewall that drops packets.
   */
  holdForwards?: boolean;
}

export interface SshTestServer {
  port: number;
  /** The host key's public blob, as a client's host verifier receives it. */
  hostKey: Buffer;
  /** Logins attempted with a credential (not the `none` probe every client starts with). */
  authAttempts: number;
  /** SSH connections accepted, open or not. */
  connections: number;
  /** Connections still open. */
  open: number;
  /** Channels opened and not yet closed. */
  channels: number;
  /** Channels opened, closed since or not. */
  channelsOpened: number;
  /** With `holdForwards`: each unanswered channel's go-ahead, in the order they were asked for. */
  heldForwards: (() => void)[];
  close(): Promise<void>;
}

/**
 * An OpenSSH-format key pair, optionally with a passphrase. ssh2's generator writes about one
 * ed25519 key in 256 a byte short — a key whose first byte is zero loses it (measured: 16 in 3,000,
 * under Node as under Bun) — and then cannot read that key itself, which failed a test run in
 * seven. So a pair is made again until ssh2 reads both halves back.
 */
export function generateKeyPair(passphrase?: string): { private: string; public: string } {
  for (;;) {
    const pair = passphrase
      ? utils.generateKeyPairSync("ed25519", { passphrase, cipher: "aes256-ctr", rounds: 4 })
      : utils.generateKeyPairSync("ed25519");
    if (!(utils.parseKey(pair.public) instanceof Error) && !(utils.parseKey(pair.private, passphrase) instanceof Error)) return pair;
  }
}

export async function startSshTestServer(options: SshTestServerOptions = {}): Promise<SshTestServer> {
  const user = options.user ?? "alice";
  const password = options.password ?? "secret";
  const hostPair = generateKeyPair();
  const allowed = options.publicKey ? utils.parseKey(options.publicKey) : null;
  const clients = new Set<{ end(): void; _sock?: net.Socket }>();
  const state: SshTestServer = {
    port: 0,
    hostKey: utils.parseKey(hostPair.public).getPublicSSH(),
    authAttempts: 0,
    connections: 0,
    open: 0,
    channels: 0,
    channelsOpened: 0,
    heldForwards: [],
    close: async () => {},
  };

  const server = new Server({ hostKeys: [hostPair.private] }, (client: any) => {
    state.connections++;
    state.open++;
    clients.add(client);
    client.on("close", () => { state.open--; clients.delete(client); });
    client.on("error", () => {});
    client.on("authentication", (ctx: any) => {
      if (ctx.method !== "none") state.authAttempts++;
      if (ctx.username !== user) return ctx.reject();
      if (ctx.method === "keyboard-interactive") {
        return ctx.prompt([{ prompt: "Password: ", echo: false }], (answers: string[]) =>
          answers[0] === password ? ctx.accept() : ctx.reject());
      }
      if (!options.keyboardOnly && ctx.method === "password") return ctx.password === password ? ctx.accept() : ctx.reject();
      if (!options.keyboardOnly && ctx.method === "publickey" && allowed) {
        const same = ctx.key.algo === allowed.type && Buffer.compare(ctx.key.data, allowed.getPublicSSH()) === 0;
        if (!same) return ctx.reject();
        if (!ctx.signature) return ctx.accept(); // the "would this key do?" query
        return allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject();
      }
      ctx.reject(options.keyboardOnly ? ["keyboard-interactive"] : ["password", "publickey", "keyboard-interactive"]);
    });
    client.on("ready", () => {
      client.on("tcpip", (accept: () => any, reject: () => void, info: { destIP: string; destPort: number }) => {
        if (options.forwarding === false) return reject();
        const connect = () => {
          const upstream = net.connect(info.destPort, info.destIP);
          upstream.once("error", () => reject());
          upstream.once("connect", () => {
            const channel = accept();
            state.channels++;
            state.channelsOpened++;
            channel.once("close", () => { state.channels--; upstream.destroy(); });
            upstream.on("close", () => channel.close());
            channel.pipe(upstream).pipe(channel);
          });
        };
        if (options.holdForwards) state.heldForwards.push(connect);
        else connect();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = server.address().port;
  state.close = () =>
    new Promise<void>((resolve) => {
      // `end()` alone can leave a socket open for good: once ssh2's server has seen the client's
      // disconnect it stops reading, so the client's FIN is never read and never closes it.
      for (const c of clients) {
        c.end();
        c._sock?.destroy();
      }
      server.close(() => resolve());
    });
  return state;
}

/** A TCP server that sends back what it receives, standing in for a database. */
export async function startEchoServer(): Promise<{ port: number; connections: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const state = { port: 0, connections: 0, close: async () => {} };
  const server = net.createServer((socket) => {
    state.connections++;
    sockets.add(socket);
    socket.on("data", (data) => socket.write(data));
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as net.AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return state;
}

/** A port nothing listens on: bound once, then released. */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
