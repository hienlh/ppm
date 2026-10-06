/**
 * SSH tunnels for database connections, with no local port.
 *
 * DBGate forwards a local port and points the driver at it. PPM hands the driver the SSH channel
 * itself: postgres.js takes an async `socket`, mysql2 a synchronous `stream`. Two reasons, both
 * measured (`plans/…/reports/02c-ssh-tunnel.md`). A local listener would let anything on the PPM
 * host ride the tunnel — every other user of a shared machine included. And Bun drops bytes that
 * reach an accepted socket before its `data` listener is attached (0 of 8 bytes arrived with the
 * listener 0, 20 or 100 ms late; Node got all 8), which is exactly the moment a database server
 * sends its greeting.
 *
 * One SSH session per connection and database address, opened on first use and shared by every
 * pooled connection behind it. It closes after a minute with no channel open, on Disconnect, on
 * an edit or delete, and when the SSH driver is removed.
 *
 * ssh2 is installed from Settings like the database drivers (`drivers/db-driver-catalog.ts`), so
 * only its shape is declared here.
 */
import type { EventEmitter } from "node:events";
import os from "node:os";
import { Duplex } from "node:stream";
import { parseSshAddress, DEFAULT_SSH_PORT, type SshHop, type SshTunnelSettings } from "../../shared/db-connection-config.ts";
import { createLogger } from "../logger.ts";
import { loadDbDriver, onDbDriverUnload } from "./drivers/db-driver-loader.ts";
import { readHostFile } from "./host-files.ts";
import { findSshAgent } from "./ssh-agent-socket.ts";
import { checkHostKey, knownHostsPath, type HostKeyCheck } from "./ssh-known-hosts.ts";

const log = createLogger("db");

/** The SSH handshake and login, for each hop: a bastion has a budget of its own. */
export const SSH_READY_TIMEOUT_MS = 10_000;
/**
 * The SSH server's own connect to the next hop, bounded as a direct connection's is. Nothing else
 * bounds it: postgres.js starts its connect timer only once it holds the socket, and an SSH server
 * whose connect meets a firewall that drops packets answers when its kernel gives up — about two
 * minutes later on Linux.
 */
export const SSH_FORWARD_TIMEOUT_MS = 15_000;
let forwardTimeoutMs = SSH_FORWARD_TIMEOUT_MS;

/**
 * The longest a tunnel may take to hand a driver its socket — each hop's login and its connect
 * onwards — which anything waiting on a tunnelled connection has to allow for, or a slow tunnel's
 * own error is lost to a shorter timeout.
 */
export function sshTunnelOpenBudgetMs(settings: SshTunnelSettings | undefined): number {
  if (!settings?.enabled) return 0;
  return (settings.bastionHost ? 2 : 1) * (SSH_READY_TIMEOUT_MS + SSH_FORWARD_TIMEOUT_MS);
}
/** A session with no channel open for this long is closed. */
let idleCloseMs = 60_000;
/** A tunnel through a NAT that forgets idle flows stays open, and a dead server is noticed within a minute. */
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 3;

interface Ssh2Channel extends Duplex {
  close(): void;
  host?: string;
  _host?: string;
  readyState?: string;
}

interface Ssh2Client extends EventEmitter {
  connect(config: Record<string, unknown>): this;
  forwardOut(srcIP: string, srcPort: number, dstIP: string, dstPort: number, cb: (err: Error | undefined, channel: Ssh2Channel) => void): this;
  end(): this;
}

type Ssh2 = { Client: new () => Ssh2Client };

export interface SshTarget {
  /** The database's address as the SSH server sees it. */
  host: string;
  port: number;
}

export type SshTunnelErrorKind =
  /** The server refused the login. */
  | "auth"
  /** No agent on the PPM host, or the agent failed. */
  | "agent"
  /** The key file cannot be read or opened. */
  | "key"
  /** The server's host key is not the one recorded for it. */
  | "host-key"
  | "timeout"
  /** The SSH server cannot be reached. */
  | "network"
  /** The SSH server could not open the connection to the database. */
  | "forward"
  /** The settings cannot be used: a bastion address that does not parse. */
  | "config";

export class SshTunnelError extends Error {
  readonly kind: SshTunnelErrorKind;
  /** What to do about it, when there is something to say. */
  readonly hint?: string;

  constructor(kind: SshTunnelErrorKind, message: string, hint?: string) {
    super(message);
    this.name = "SshTunnelError";
    this.kind = kind;
    this.hint = hint;
  }
}

interface Hop {
  host: string;
  port: number;
  user: string;
}

interface Session {
  key: string;
  /** `user@host:port[ via bastion] → db host:port`, for the log. */
  label: string;
  ready: Promise<Ssh2Client>;
  clients: Ssh2Client[];
  hops: SshHop[];
  channels: number;
  idle?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

const sessions = new Map<string, Session>();

onDbDriverUnload("ssh", () => closeAllSshTunnels());

/** The user `ssh` would log in as when none is given; empty when the process cannot tell. */
export function localSshUser(): string {
  try {
    const name = os.userInfo().username;
    if (name) return name;
  } catch { /* no passwd entry, as in some containers */ }
  return process.env.USER || process.env.USERNAME || "";
}

function hopsOf(settings: SshTunnelSettings): Hop[] {
  const host = settings.host.trim();
  if (!host) throw new SshTunnelError("config", "Enter the SSH host.");
  const user = settings.user.trim() || localSshUser();
  if (!user) throw new SshTunnelError("config", "Enter the SSH login: PPM cannot tell which user it runs as.");
  const server: Hop = { host, port: settings.port ?? DEFAULT_SSH_PORT, user };
  if (!settings.bastionHost?.trim()) return [server];
  const bastion = parseSshAddress(settings.bastionHost);
  if ("error" in bastion) throw new SshTunnelError("config", bastion.error);
  return [{ host: bastion.host, port: bastion.port, user: bastion.user || user }, server];
}

/**
 * The route for the log: logins and hosts, never a credential. A login name cannot hold a `:`, so
 * whatever follows one is a password typed into the wrong field and is left out.
 */
function routeLabel(settings: SshTunnelSettings, target: SshTarget): string {
  let route: string;
  try {
    const hops = hopsOf(settings).map((h) => `${h.user.split(":")[0]}@${h.host}:${h.port}`);
    route = hops.length > 1 ? `${hops[1]} via ${hops[0]}` : hops[0]!;
  } catch {
    route = `${settings.host.trim()}:${settings.port ?? DEFAULT_SSH_PORT}`;
  }
  return `${route} → ${target.host}:${target.port}`;
}

/** The login options every hop shares: the same credentials reach the bastion and the server, as in DBGate. */
function authOptions(settings: SshTunnelSettings): Record<string, unknown> {
  switch (settings.auth) {
    case "password":
      // `tryKeyboard`: many servers turn plain password logins off and ask the same question
      // through keyboard-interactive, which ssh2 only answers when told to.
      return { password: settings.password ?? "", tryKeyboard: true };
    case "agent": {
      const agent = findSshAgent();
      if (!agent) {
        throw new SshTunnelError(
          "agent",
          "No SSH agent found on the PPM host.",
          "Start one there and add your key (ssh-add), or pick Key file and point it at the key.",
        );
      }
      return { agent };
    }
    case "keyFile": {
      if (!settings.keyFile?.trim()) throw new SshTunnelError("key", "Pick the private key file.");
      let privateKey: Buffer;
      try {
        privateKey = readHostFile(settings.keyFile, "SSH key file");
      } catch (e) {
        throw new SshTunnelError("key", (e as Error).message);
      }
      return { privateKey, ...(settings.passphrase ? { passphrase: settings.passphrase } : {}) };
    }
  }
}

/** ssh2 reads the key inside `connect()` and throws there; say which of the usual things it is. */
function keyError(e: Error, settings: SshTunnelSettings): SshTunnelError {
  const text = e.message;
  if (/no passphrase given/i.test(text)) {
    return new SshTunnelError("key", "The key file is protected by a passphrase.", "Enter it in Key file passphrase.");
  }
  if (/bad passphrase/i.test(text)) {
    return new SshTunnelError("key", "The key file's passphrase is wrong.", settings.passphrase ? undefined : "Enter it in Key file passphrase.");
  }
  if (/does not contain a \(valid\) private key/i.test(text)) {
    return new SshTunnelError("key", `${settings.keyFile} is not a private key.`, "A file ending in .pub is the public half; pick the one without it.");
  }
  return new SshTunnelError("key", `Cannot use the key file ${settings.keyFile}: ${text.replace(/^Cannot parse privateKey: /, "")}`);
}

function hostKeyError(hop: Hop, check: Extract<HostKeyCheck, { status: "changed" }>): SshTunnelError {
  const where = `${knownHostsPath()}, line${check.lines.length > 1 ? "s" : ""} ${check.lines.join(", ")}`;
  return new SshTunnelError(
    "host-key",
    `The SSH server ${hop.host}:${hop.port} showed a different host key (${check.fingerprint}) from the one PPM recorded (${check.recorded.join(", ")}).`,
    `Someone may be in the middle, or the server was reinstalled. Only if you know it was reinstalled, delete ${where} and connect again.`,
  );
}

/** What went wrong with one hop, from ssh2's error and what the host key check saw. */
function hopError(e: Error & { level?: string; code?: string }, hop: Hop, settings: SshTunnelSettings, hostKey: HostKeyCheck | null): SshTunnelError {
  if (e instanceof SshTunnelError) return e;
  if (hostKey?.status === "changed") return hostKeyError(hop, hostKey);
  const at = `${hop.host}:${hop.port}`;
  switch (e.level) {
    case "client-authentication": {
      const how = settings.auth === "password" ? "the password" : settings.auth === "agent" ? "the keys in the SSH agent" : "the key file";
      return new SshTunnelError("auth", `The SSH server ${at} refused ${hop.user}'s login with ${how}.`, "Check the login and the credentials on the SSH Tunnel tab.");
    }
    case "agent":
      return new SshTunnelError("agent", `The SSH agent failed: ${e.message}`, "Check that the agent is running and holds a key (ssh-add -l).");
    case "client-timeout":
      return /keepalive/i.test(e.message)
        ? new SshTunnelError("timeout", `The SSH server ${at} stopped answering.`)
        : new SshTunnelError("timeout", `The SSH server ${at} did not finish logging in within ${SSH_READY_TIMEOUT_MS / 1000} s.`);
    case "client-socket":
    case "client-dns": {
      const code = e.code ?? "";
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new SshTunnelError("network", `Cannot find the SSH host ${hop.host} (${code}).`, "Check the host name on the SSH Tunnel tab.");
      if (code === "ECONNREFUSED") return new SshTunnelError("network", `Nothing accepts SSH connections at ${at} (ECONNREFUSED).`, "Check the SSH port, and that the SSH server is running.");
      return new SshTunnelError("network", `Cannot reach the SSH server ${at}: ${e.message}`);
    }
  }
  return new SshTunnelError("network", `The SSH connection to ${at} failed: ${e.message}`);
}

/**
 * Log in to one hop, over `sock` when it is reached through the previous one. `record` gets the
 * host key it showed.
 */
function connectHop(
  ssh: Ssh2,
  hop: Hop,
  settings: SshTunnelSettings,
  auth: Record<string, unknown>,
  sock: Duplex | undefined,
  record: (hop: SshHop) => void,
): Promise<Ssh2Client> {
  return new Promise((resolve, reject) => {
    const client = new ssh.Client();
    let hostKey: HostKeyCheck | null = null;
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(hopError(e, hop, settings, hostKey));
    };
    client.on("error", fail);
    client.once("close", () => fail(new Error("The SSH server closed the connection during login")));
    client.once("ready", () => {
      if (settled) return;
      settled = true;
      resolve(client);
    });
    client.on("keyboard-interactive", (_name: string, _instructions: string, _lang: string, prompts: unknown[], finish: (answers: string[]) => void) => {
      // Only the password method answers; the others have nothing to type.
      finish(settings.auth === "password" ? prompts.map(() => settings.password ?? "") : []);
    });
    try {
      client.connect({
        host: hop.host,
        port: hop.port,
        username: hop.user,
        ...(sock ? { sock } : {}),
        ...auth,
        readyTimeout: SSH_READY_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        // Synchronous: ssh2 asks in the middle of the handshake. A changed key is refused here,
        // before any credential is sent to a server that may not be the right one.
        hostVerifier: (key: Buffer) => {
          hostKey = checkHostKey(hop.host, hop.port, key);
          record({ host: `${hop.host}:${hop.port}`, fingerprint: hostKey.fingerprint, firstSeen: hostKey.status === "added" });
          return hostKey.status !== "changed";
        },
      });
    } catch (e) {
      settled = true;
      reject(keyError(e as Error, settings));
    }
  });
}

/** The SSH server gave no answer to a channel open within `forwardTimeoutMs`. */
class ForwardTimeout extends Error {
  constructor() {
    super(`no answer within ${forwardTimeoutMs / 1000} s`);
  }
}

function forward(client: Ssh2Client, target: SshTarget): Promise<Ssh2Channel> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new ForwardTimeout());
    }, forwardTimeoutMs);
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      if (settled) return false;
      settled = true;
      fn();
      return true;
    };
    try {
      client.forwardOut("127.0.0.1", 0, target.host, target.port, (err, channel) => {
        // An answer after the timeout: nothing waits for this channel any more.
        if (!settle(() => (err ? reject(err) : resolve(channel))) && !err) channel.close();
      });
    } catch (e) {
      settle(() => reject(e)); // "Not connected": the session died between being looked up and used
    }
  });
}

/** Log in hop by hop, each after the first reached through the one before. */
async function openSession(session: Session, settings: SshTunnelSettings): Promise<Ssh2Client> {
  // The driver first: a missing one is the error with an Install button.
  const ssh = await loadDbDriver<Ssh2>("ssh");
  const route = hopsOf(settings);
  const auth = authOptions(settings);
  let sock: Duplex | undefined;
  let client: Ssh2Client | undefined;
  for (const [index, hop] of route.entries()) {
    if (client) {
      try {
        sock = await forward(client, { host: hop.host, port: hop.port });
      } catch (e) {
        throw new SshTunnelError("forward", `The bastion could not reach the SSH server ${hop.host}:${hop.port}: ${channelFailure(e as Error)}`);
      }
    }
    client = await connectHop(ssh, hop, settings, auth, sock, (seen) => { session.hops[index] = seen; });
    session.clients.push(client);
    // Closed while this hop logged in, by Disconnect or an edit: closing did not see this client.
    if (session.closed) {
      endClients(session);
      throw new SshTunnelError("network", "The SSH tunnel was closed while it opened.");
    }
  }
  return client!;
}

/** RFC 4254's reason codes, for a server that sends one with no description. */
const OPEN_FAILURE_REASONS: Record<number, string> = {
  1: "administratively prohibited", 2: "connect failed", 3: "unknown channel type", 4: "resource shortage",
};
const ADMINISTRATIVELY_PROHIBITED = 1;

/**
 * The reason in `(SSH) Channel open failure: Connection refused`. OpenSSH describes a forward its
 * own policy refuses (PermitOpen, AllowTcpForwarding) only as "open failed", which says less than
 * the code it sends with it.
 */
function channelFailure(e: Error & { reason?: unknown }): string {
  const text = e.message.replace(/^\(SSH\) Channel open failure:\s*/, "").trim();
  const named = typeof e.reason === "number" ? OPEN_FAILURE_REASONS[e.reason] : undefined;
  if (!text || (text === "open failed" && named)) return named ?? "the SSH server gave no reason";
  return text;
}

/** What to say when the SSH server did not open the connection to `target`: `e` is ssh2's error. */
export function sshForwardError(e: Error & { reason?: unknown }, target: SshTarget): SshTunnelError {
  const reason = channelFailure(e);
  const at = `${target.host}:${target.port}`;
  if (e instanceof ForwardTimeout) {
    return new SshTunnelError(
      "timeout", `The SSH server did not reach ${at} within ${forwardTimeoutMs / 1000} s.`,
      "The database's host and port are as the SSH server sees them: often localhost. A firewall between the two may be dropping the connection.",
    );
  }
  if (e.reason === ADMINISTRATIVELY_PROHIBITED || /prohibited/i.test(reason)) {
    return new SshTunnelError("forward", `The SSH server does not allow connections to ${at} (${reason}).`, "Port forwarding is off there (AllowTcpForwarding or PermitOpen in sshd_config).");
  }
  if (/refused/i.test(reason)) {
    return new SshTunnelError("forward", `The SSH server reached ${at}, but nothing accepts connections there (${reason}).`, "The database's host and port are as the SSH server sees them: often localhost.");
  }
  return new SshTunnelError("forward", `The SSH server could not connect to ${at}: ${reason}`, "The database's host and port are as the SSH server sees them: often localhost.");
}

/** Server first: its connection runs inside the bastion's. */
function endClients(session: Session): void {
  for (const client of [...session.clients].reverse()) {
    try { client.end(); } catch { /* already gone */ }
  }
}

/** `reason` is for a tunnel that was up; one that failed to open, or failed once up, was already logged. */
function closeSession(session: Session, reason?: string): void {
  if (session.closed) return;
  if (reason) log.info(`SSH tunnel ${session.label} closed (${reason})`);
  session.closed = true;
  clearTimeout(session.idle);
  if (sessions.get(session.key) === session) sessions.delete(session.key);
  endClients(session);
}

function sessionKey(key: string, target: SshTarget): string {
  return `${key}\n${target.host.toLowerCase()}:${target.port}`;
}

function session(key: string, settings: SshTunnelSettings, target: SshTarget): Session {
  const id = sessionKey(key, target);
  const existing = sessions.get(id);
  if (existing && !existing.closed) return existing;
  const created: Session = {
    key: id, label: routeLabel(settings, target), clients: [], hops: [], channels: 0, closed: false, ready: undefined!,
  };
  const startedAt = performance.now();
  created.ready = openSession(created, settings).then(
    (client) => {
      log.info(`SSH tunnel up ${created.label} in ${Math.round(performance.now() - startedAt)}ms`);
      // After login a failure has no caller to go to; it ends the session, and the next
      // connection opens a new one. Without a listener it would crash the process.
      for (const c of created.clients) {
        c.on("error", (e: Error) => {
          if (!created.closed) log.warn(`SSH tunnel ${created.label} failed: ${e.message}; closed`);
          closeSession(created);
        });
        c.once("close", () => closeSession(created, "the SSH connection ended"));
      }
      return client;
    },
    (e) => {
      // Also thrown to whoever asked for the connection; this is the copy that outlives the request.
      if (!created.closed) {
        log.warn(`SSH tunnel ${created.label} failed (${e instanceof SshTunnelError ? e.kind : "error"}): ${(e as Error).message}`);
      }
      closeSession(created);
      throw e;
    },
  );
  sessions.set(id, created);
  return created;
}

function channelOpened(session: Session): void {
  session.channels++;
  clearTimeout(session.idle);
}

function channelClosed(session: Session): void {
  session.channels = Math.max(0, session.channels - 1);
  if (session.channels === 0 && !session.closed) {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => closeSession(session, `idle ${Math.round(idleCloseMs / 1000)}s`), idleCloseMs);
    session.idle.unref?.();
  }
}

/**
 * One connection to `target` through the tunnel `key` names. `key` must identify the settings —
 * the caller's endpoint id — so a changed password gets a new session instead of one logged in
 * with the old.
 */
export async function openSshChannel(key: string, settings: SshTunnelSettings, target: SshTarget): Promise<Ssh2Channel> {
  for (let attempt = 0; ; attempt++) {
    const s = session(key, settings, target);
    channelOpened(s);
    let channel: Ssh2Channel;
    try {
      const client = await s.ready;
      channel = await forward(client, target);
    } catch (e) {
      channelClosed(s);
      if (e instanceof SshTunnelError) throw e;
      // A session that died after it was looked up, before its close event said so.
      if ((e as Error).message === "Not connected") closeSession(s, "found disconnected, logging in again");
      if (s.closed && attempt === 0) continue; // log in again, once
      throw sshForwardError(e as Error, target);
    }
    let open = true;
    channel.once("close", () => {
      if (!open) return;
      open = false;
      channelClosed(s);
    });
    // The TLS server name both drivers derive from their socket: the database's own host.
    channel.host = target.host;
    channel._host = target.host;
    // A `net.Socket` property postgres.js decides with: it only sends Terminate and ends a socket
    // whose `readyState` is "open", then waits for "close" unless it is "closed". A channel has
    // none, so a pool ending — idle or on Disconnect — left every channel, and the database
    // session behind it, open until the tunnel closed.
    Object.defineProperty(channel, "readyState", {
      configurable: true,
      get: () => (!open ? "closed" : channel.writable ? "open" : "readOnly"),
    });
    return channel;
  }
}

/**
 * A stream usable at once, joined to a channel when it opens: what mysql2's synchronous `stream`
 * option needs. A failure to open destroys the stream with the reason, which mysql2 reports as
 * the connection's error.
 */
export function sshChannelStream(key: string, settings: SshTunnelSettings, target: SshTarget): Duplex {
  const stream = new PendingChannel(target.host);
  openSshChannel(key, settings, target).then(
    (channel) => stream.attach(channel),
    (e: Error) => stream.destroy(e),
  );
  return stream;
}

class PendingChannel extends Duplex {
  private channel: Ssh2Channel | null = null;
  private queued: { chunk: Buffer; cb: (e?: Error | null) => void }[] = [];
  private ending: (() => void) | null = null;
  /** Read by TLS for the server name when it is given no other. */
  readonly _host: string;

  constructor(host: string) {
    super();
    this._host = host;
  }

  attach(channel: Ssh2Channel): void {
    // mysql2 gave up first (its connect timeout): nothing will read this channel.
    if (this.destroyed) {
      channel.close();
      return;
    }
    this.channel = channel;
    channel.on("data", (data: Buffer) => { if (!this.push(data)) channel.pause(); });
    channel.on("end", () => this.push(null));
    channel.on("error", (e: Error) => this.destroy(e));
    channel.on("close", () => this.destroy());
    for (const { chunk, cb } of this.queued.splice(0)) channel.write(chunk, cb);
    if (this.ending) {
      channel.end();
      this.ending();
    }
  }

  override _read(): void {
    this.channel?.resume();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, cb: (e?: Error | null) => void): void {
    if (this.channel) this.channel.write(chunk, cb);
    else this.queued.push({ chunk, cb });
  }

  override _final(cb: (e?: Error | null) => void): void {
    if (this.channel) {
      this.channel.end();
      cb();
    } else {
      this.ending = () => cb();
    }
  }

  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    this.channel?.close();
    for (const { cb: pending } of this.queued.splice(0)) pending(err ?? new Error("The SSH channel closed"));
    cb(err);
  }
}

/** The SSH servers the live session for `key` and `target` went through, bastion first. */
export function sshTunnelHops(key: string, target: SshTarget): SshHop[] | null {
  const s = sessions.get(sessionKey(key, target));
  return s && !s.closed && s.hops.length > 0 ? [...s.hops] : null;
}

/** Close every session opened under `key`, whatever database it reached. */
export function closeSshTunnels(key: string): void {
  for (const s of [...sessions.values()]) {
    if (s.key.startsWith(`${key}\n`)) closeSession(s, "disconnected");
  }
}

export function closeAllSshTunnels(): void {
  for (const s of [...sessions.values()]) closeSession(s, "closing every tunnel");
}

/** How many sessions are open. */
export function openSshTunnelCount(): number {
  return sessions.size;
}

/** Tests only: a shorter wait for a channel the SSH server does not answer. */
export function _setSshForwardTimeoutMs(ms: number): void {
  forwardTimeoutMs = ms;
}

/** Tests only: how long an unused session stays open. */
export function _setSshIdleCloseMs(ms: number): void {
  idleCloseMs = ms;
}
