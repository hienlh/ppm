/**
 * SSH tunnels, end to end against ssh2's own server running in this process
 * (`tests/helpers/ssh-test-server.ts`) and the SSH driver installed the way Settings installs it —
 * bundled, loaded, checked — from the repository's own copy. What is pinned: every login method
 * reaches the database's port; a host key is trusted the first time and a different one refused
 * *before* any credential is sent; a bastion is gone through; one session serves every channel
 * and closes when it has none; and each failure says which of the usual things it is.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { copyingRunner } from "../../../helpers/db-driver-offline-install.ts";
import {
  closedPort, generateKeyPair, startEchoServer, startSshTestServer, type SshTestServer,
} from "../../../helpers/ssh-test-server.ts";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { installDbDriver } from "../../../../src/services/database/drivers/db-driver-install.ts";
import { unloadDbDriver } from "../../../../src/services/database/drivers/db-driver-loader.ts";
import { knownHostsPath } from "../../../../src/services/database/ssh-known-hosts.ts";
import {
  _setSshForwardTimeoutMs, _setSshIdleCloseMs, closeAllSshTunnels, closeSshTunnels, openSshChannel, openSshTunnelCount, sshChannelStream,
  SSH_FORWARD_TIMEOUT_MS, sshForwardError, sshTunnelHops, SshTunnelError,
} from "../../../../src/services/database/ssh-tunnel.ts";
import type { SshTunnelSettings } from "../../../../src/shared/db-connection-config.ts";

const originalPpmHome = process.env.PPM_HOME;
const ppmHome = mkdtempSync(join(tmpdir(), "ppm-ssh-tunnel-"));
/** Outside the PPM directory, which the key file reader refuses. */
const keys = mkdtempSync(join(tmpdir(), "ppm-ssh-keys-"));

let echo: Awaited<ReturnType<typeof startEchoServer>>;
const servers: SshTestServer[] = [];
let key = 0;
/** A fresh tunnel identity per test, as the endpoint layer gives each set of settings its own. */
const nextKey = () => `test-${++key}`;

async function server(options?: Parameters<typeof startSshTestServer>[0]): Promise<SshTestServer> {
  const s = await startSshTestServer(options);
  servers.push(s);
  return s;
}

function password(s: SshTestServer, extra: Partial<SshTunnelSettings> = {}): SshTunnelSettings {
  return { enabled: true, host: "127.0.0.1", port: s.port, auth: "password", user: "alice", password: "secret", ...extra };
}

/** Send `text` down the stream and read the same back through the echo server. */
function roundTrip(stream: Duplex, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let got = "";
    stream.on("data", (d: Buffer) => {
      got += d.toString();
      if (got.length >= text.length) resolve(got);
    });
    stream.once("error", reject);
    stream.write(text);
  });
}

async function failure(promise: Promise<unknown>): Promise<SshTunnelError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(SshTunnelError);
    return e as SshTunnelError;
  }
  throw new Error("expected the tunnel to fail");
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

beforeAll(async () => {
  process.env.PPM_HOME = ppmHome;
  _resetPpmDir();
  await unloadDbDriver("ssh");
  await installDbDriver("ssh", { run: copyingRunner("ssh") });
  echo = await startEchoServer();
});

beforeEach(() => {
  rmSync(knownHostsPath(), { force: true });
});

afterEach(async () => {
  closeAllSshTunnels();
  _setSshIdleCloseMs(60_000);
  _setSshForwardTimeoutMs(SSH_FORWARD_TIMEOUT_MS);
  for (const s of servers.splice(0)) await s.close();
});

afterAll(async () => {
  await echo.close();
  await unloadDbDriver("ssh");
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(ppmHome, { recursive: true, force: true });
  rmSync(keys, { recursive: true, force: true });
});

describe("logging in", () => {
  it("reaches the database's port with a password, and records the host key the first time", async () => {
    const s = await server();
    const tunnel = nextKey();
    const target = { host: "127.0.0.1", port: echo.port };
    const channel = await openSshChannel(tunnel, password(s), target);
    expect(await roundTrip(channel, "ping")).toBe("ping");
    const [hop] = sshTunnelHops(tunnel, target)!;
    expect(hop).toEqual({ host: `127.0.0.1:${s.port}`, fingerprint: expect.stringMatching(/^SHA256:[A-Za-z0-9+/]{43}$/), firstSeen: true });
    expect(readFileSync(knownHostsPath(), "utf8")).toBe(`[127.0.0.1]:${s.port} ssh-ed25519 ${s.hostKey.toString("base64")}\n`);
    // The driver takes the TLS server name from its socket: the database's host, not the SSH server's.
    expect(channel.host).toBe("127.0.0.1");
    expect(channel._host).toBe("127.0.0.1");

    // A second session finds it recorded.
    const again = nextKey();
    await openSshChannel(again, password(s), target);
    expect(sshTunnelHops(again, target)![0]!.firstSeen).toBe(false);
  });

  it("answers keyboard-interactive with the password, where the server asks that way", async () => {
    const s = await server({ keyboardOnly: true });
    const channel = await openSshChannel(nextKey(), password(s), { host: "127.0.0.1", port: echo.port });
    expect(await roundTrip(channel, "kbd")).toBe("kbd");
  });

  it("logs in with a key file, and with its passphrase when it has one", async () => {
    const plain = generateKeyPair();
    const locked = generateKeyPair("hunter2");
    writeFileSync(join(keys, "id_plain"), plain.private);
    writeFileSync(join(keys, "id_locked"), locked.private);
    const target = { host: "127.0.0.1", port: echo.port };

    const a = await server({ publicKey: plain.public });
    const viaKey = await openSshChannel(nextKey(), { ...password(a), auth: "keyFile", password: undefined, keyFile: join(keys, "id_plain") }, target);
    expect(await roundTrip(viaKey, "key")).toBe("key");

    const b = await server({ publicKey: locked.public });
    const settings: SshTunnelSettings = { ...password(b), auth: "keyFile", password: undefined, keyFile: join(keys, "id_locked") };
    const missing = await failure(openSshChannel(nextKey(), settings, target));
    expect(missing.kind).toBe("key");
    expect(missing.message).toBe("The key file is protected by a passphrase.");
    const wrong = await failure(openSshChannel(nextKey(), { ...settings, passphrase: "nope" }, target));
    expect(wrong.message).toBe("The key file's passphrase is wrong.");
    // Neither reached the server: the key is opened on the PPM host, before connecting.
    expect(b.connections).toBe(0);
    const ok = await openSshChannel(nextKey(), { ...settings, passphrase: "hunter2" }, target);
    expect(await roundTrip(ok, "locked")).toBe("locked");
  });

  it("says which login was refused, and does not keep the failed session", async () => {
    const s = await server();
    const tunnel = nextKey();
    const e = await failure(openSshChannel(tunnel, password(s, { password: "wrong" }), { host: "127.0.0.1", port: echo.port }));
    expect(e.kind).toBe("auth");
    expect(e.message).toBe(`The SSH server 127.0.0.1:${s.port} refused alice's login with the password.`);
    expect(openSshTunnelCount()).toBe(0);
  });

  it("says a public key file is the wrong half", async () => {
    const pair = generateKeyPair();
    writeFileSync(join(keys, "id.pub"), pair.public);
    const s = await server({ publicKey: pair.public });
    const e = await failure(openSshChannel(nextKey(), { ...password(s), auth: "keyFile", keyFile: join(keys, "id.pub") }, { host: "127.0.0.1", port: echo.port }));
    expect(e.kind).toBe("key");
    expect(e.message).toBe(`${join(keys, "id.pub")} is not a private key.`);
    expect(s.connections).toBe(0);
  });

  it("refuses a host key that is not the recorded one, before sending any credential", async () => {
    const s = await server();
    const other = await server();
    mkdirSync(join(ppmHome, "ssh"), { recursive: true });
    writeFileSync(knownHostsPath(), `# PPM\n[127.0.0.1]:${s.port} ssh-ed25519 ${other.hostKey.toString("base64")}\n`);
    const e = await failure(openSshChannel(nextKey(), password(s), { host: "127.0.0.1", port: echo.port }));
    expect(e.kind).toBe("host-key");
    expect(e.message).toContain(`The SSH server 127.0.0.1:${s.port} showed a different host key`);
    expect(e.hint).toContain(`delete ${knownHostsPath()}, line 2 and connect again`);
    expect(s.authAttempts).toBe(0);
    // And the recorded key stays as it was.
    expect(readFileSync(knownHostsPath(), "utf8")).toContain(other.hostKey.toString("base64"));
  });

  it("says nothing listens where the SSH server should be", async () => {
    const port = await closedPort();
    const e = await failure(openSshChannel(nextKey(), { enabled: true, host: "127.0.0.1", port, auth: "password", user: "alice", password: "x" }, { host: "127.0.0.1", port: echo.port }));
    expect(e.kind).toBe("network");
    expect(e.message).toBe(`Nothing accepts SSH connections at 127.0.0.1:${port} (ECONNREFUSED).`);
  });
});

describe("reaching the database", () => {
  it("says the SSH server could not connect to a closed port", async () => {
    const s = await server();
    const port = await closedPort();
    const e = await failure(openSshChannel(nextKey(), password(s), { host: "127.0.0.1", port }));
    expect(e.kind).toBe("forward");
    // ssh2's server gives no description, only the RFC's reason code.
    expect(e.message).toBe(`The SSH server could not connect to 127.0.0.1:${port}: connect failed`);
    // The login worked, so the session stays for the next connection.
    expect(openSshTunnelCount()).toBe(1);
  });

  it("reads OpenSSH's refusals, where the code can say more than the text", () => {
    // What ssh2 makes of each, as OpenSSH 9.7 sent them (tests/integration/database-ssh-ssl.test.ts).
    const openFailure = (description: string, reason: number) => Object.assign(new Error(`(SSH) Channel open failure: ${description}`), { reason });
    const target = { host: "db", port: 5432 };
    // PermitOpen or AllowTcpForwarding: the text is "open failed", and only the code says why.
    const prohibited = sshForwardError(openFailure("open failed", 1), target);
    expect(prohibited.message).toBe("The SSH server does not allow connections to db:5432 (administratively prohibited).");
    expect(prohibited.hint).toContain("AllowTcpForwarding or PermitOpen");
    expect(sshForwardError(openFailure("Connection refused", 2), target).message)
      .toBe("The SSH server reached db:5432, but nothing accepts connections there (Connection refused).");
    expect(sshForwardError(openFailure("Name does not resolve", 2), target).message).toBe("The SSH server could not connect to db:5432: Name does not resolve");
    expect(sshForwardError(openFailure("open failed", 2), target).message).toBe("The SSH server could not connect to db:5432: connect failed");
  });

  it("gives up on a connect the SSH server does not answer, and closes the channel if it opens later", async () => {
    _setSshForwardTimeoutMs(100);
    const s = await server({ holdForwards: true });
    const tunnel = nextKey();
    const target = { host: "127.0.0.1", port: echo.port };
    const e = await failure(openSshChannel(tunnel, password(s), target));
    expect(e.kind).toBe("timeout");
    expect(e.message).toBe(`The SSH server did not reach 127.0.0.1:${echo.port} within 0.1 s.`);
    expect(e.hint).toContain("A firewall between the two may be dropping the connection.");
    // The SSH server's connect goes through after all: nothing waits for that channel.
    s.heldForwards.shift()!();
    await until(() => s.channelsOpened === 1 && s.channels === 0);
    // The session itself is fine, and serves the next connection.
    const next = openSshChannel(tunnel, password(s), target);
    await until(() => s.heldForwards.length === 1);
    s.heldForwards.shift()!();
    expect(await roundTrip(await next, "later")).toBe("later");
    expect(s.connections).toBe(1);
  });

  it("gives up on a bastion that does not reach the SSH server", async () => {
    _setSshForwardTimeoutMs(100);
    const bastion = await server({ user: "jump", holdForwards: true });
    const inner = await server({ user: "jump" });
    const settings: SshTunnelSettings = { ...password(inner, { user: "jump" }), bastionHost: `127.0.0.1:${bastion.port}` };
    const e = await failure(openSshChannel(nextKey(), settings, { host: "127.0.0.1", port: echo.port }));
    expect(e.message).toBe(`The bastion could not reach the SSH server 127.0.0.1:${inner.port}: no answer within 0.1 s`);
    expect(inner.connections).toBe(0);
    expect(openSshTunnelCount()).toBe(0);
  });

  it("goes through a bastion, recording both host keys", async () => {
    const bastion = await server({ user: "jump" , password: "secret" });
    const inner = await server({ user: "jump", password: "secret" });
    const tunnel = nextKey();
    const target = { host: "127.0.0.1", port: echo.port };
    const settings: SshTunnelSettings = {
      enabled: true, host: "127.0.0.1", port: inner.port, bastionHost: `127.0.0.1:${bastion.port}`, auth: "password", user: "jump", password: "secret",
    };
    const channel = await openSshChannel(tunnel, settings, target);
    expect(await roundTrip(channel, "hop")).toBe("hop");
    expect(sshTunnelHops(tunnel, target)!.map((h) => [h.host, h.firstSeen])).toEqual([
      [`127.0.0.1:${bastion.port}`, true],
      [`127.0.0.1:${inner.port}`, true],
    ]);
    // The inner server is reached from the bastion, never directly.
    expect(bastion.channels).toBe(1);
    expect(inner.connections).toBe(1);
  });

  it("takes the bastion's own user when its address names one", async () => {
    const bastion = await server({ user: "deploy" });
    const inner = await server({ user: "alice" });
    const settings: SshTunnelSettings = { ...password(inner), bastionHost: `deploy@127.0.0.1:${bastion.port}` };
    const channel = await openSshChannel(nextKey(), settings, { host: "127.0.0.1", port: echo.port });
    expect(await roundTrip(channel, "users")).toBe("users");
  });

  it("refuses a bastion address it cannot read", async () => {
    const s = await server();
    const e = await failure(openSshChannel(nextKey(), password(s, { bastionHost: "jump:99999" }), { host: "127.0.0.1", port: echo.port }));
    expect(e.kind).toBe("config");
    expect(s.connections).toBe(0);
  });
});

describe("the session", () => {
  it("serves every channel from one SSH connection, and closes a minute after the last", async () => {
    _setSshIdleCloseMs(80);
    const s = await server();
    const tunnel = nextKey();
    const target = { host: "127.0.0.1", port: echo.port };
    const [a, b] = await Promise.all([openSshChannel(tunnel, password(s), target), openSshChannel(tunnel, password(s), target)]);
    // Read, as a driver does: ssh2 reports a channel closed only once its data has been consumed.
    a.resume();
    b.resume();
    expect(s.connections).toBe(1);
    expect(s.channels).toBe(2);
    a.close();
    await until(() => s.channels === 1, 1000).catch(() => { throw new Error(`server channels still ${s.channels}`); });
    await Bun.sleep(150);
    expect(openSshTunnelCount()).toBe(1); // one channel is still open
    b.close();
    await until(() => openSshTunnelCount() === 0, 1000).catch(() => { throw new Error(`tunnels still ${openSshTunnelCount()}`); });
    await until(() => s.open === 0, 1000).catch(() => { throw new Error(`server connections still ${s.open}`); });
  });

  it("closes every session of a tunnel on request, and a later channel logs in again", async () => {
    const s = await server();
    const tunnel = nextKey();
    const target = { host: "127.0.0.1", port: echo.port };
    await openSshChannel(tunnel, password(s), target);
    await openSshChannel(tunnel, password(s), { host: "localhost", port: echo.port });
    expect(openSshTunnelCount()).toBe(2);
    closeSshTunnels(tunnel);
    expect(openSshTunnelCount()).toBe(0);
    await until(() => s.open === 0);
    const channel = await openSshChannel(tunnel, password(s), target);
    expect(await roundTrip(channel, "back")).toBe("back");
    expect(s.connections).toBe(3);
  });

  it("does not keep a session that is closed while it logs in", async () => {
    const s = await server();
    const tunnel = nextKey();
    const pending = openSshChannel(tunnel, password(s), { host: "127.0.0.1", port: echo.port });
    closeSshTunnels(tunnel); // Disconnect pressed while the login is still under way
    const e = await failure(pending);
    expect(e.message).toBe("The SSH tunnel was closed while it opened.");
    expect(openSshTunnelCount()).toBe(0);
    await until(() => s.connections === 1 && s.open === 0);
  });

  it("opens a new session when the server has dropped the old one", async () => {
    const s = await server();
    const tunnel = nextKey();
    const target = { host: "127.0.0.1", port: echo.port };
    await openSshChannel(tunnel, password(s), target);
    await s.close(); // drops every connection, and stops listening
    const again = await server();
    // Same settings, new server on another port: the old session is gone and nothing is reused.
    await until(() => openSshTunnelCount() === 0);
    const channel = await openSshChannel(tunnel, password(again), target);
    expect(await roundTrip(channel, "new")).toBe("new");
  });
});

describe("the channel postgres.js is given", () => {
  // postgres.js sends Terminate and ends a socket only when its `readyState` is "open", then waits
  // for "close" unless it is "closed" — a net.Socket property no SSH channel has. Measured without
  // it against a real server: `sql.end()` never resolved and all three sessions stayed open.
  it("reports a socket's readyState: open, then closed", async () => {
    const s = await server();
    const channel = await openSshChannel(nextKey(), password(s), { host: "127.0.0.1", port: echo.port });
    channel.resume();
    expect(channel.readyState).toBe("open");
    channel.end();
    await until(() => channel.readyState === "closed");
    await until(() => s.channels === 0);
  });
});

describe("the stream mysql2 is given", () => {
  it("can be written to before the channel opens", async () => {
    const s = await server();
    const stream = sshChannelStream(nextKey(), password(s), { host: "127.0.0.1", port: echo.port });
    expect(await roundTrip(stream, "early")).toBe("early");
    stream.destroy();
    await until(() => s.channels === 0);
  });

  it("closes a channel that opens after the driver gave up on it", async () => {
    const s = await server();
    const stream = sshChannelStream(nextKey(), password(s), { host: "127.0.0.1", port: echo.port });
    stream.destroy();
    await until(() => s.connections === 1);
    await Bun.sleep(100);
    expect(s.channels).toBe(0);
  });

  it("fails with the tunnel's own error", async () => {
    const s = await server();
    const stream = sshChannelStream(nextKey(), password(s, { password: "wrong" }), { host: "127.0.0.1", port: echo.port });
    const e = await new Promise<Error>((resolve) => stream.once("error", resolve));
    expect(e).toBeInstanceOf(SshTunnelError);
    expect((e as SshTunnelError).kind).toBe("auth");
  });

  it("names the database's host for TLS", () => {
    const stream = sshChannelStream(nextKey(), { enabled: true, host: "127.0.0.1", port: 1, auth: "password", user: "a", password: "b" }, { host: "db.internal", port: 5432 });
    stream.on("error", () => {});
    expect((stream as Duplex & { _host?: string })._host).toBe("db.internal");
    stream.destroy();
  });
});

describe("key files on the PPM host", () => {
  it("refuses one that is not readable, saying so", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // root reads anything
    const pair = generateKeyPair();
    const file = join(keys, "id_unreadable");
    writeFileSync(file, pair.private);
    chmodSync(file, 0o000);
    const s = await server({ publicKey: pair.public });
    const e = await failure(openSshChannel(nextKey(), { ...password(s), auth: "keyFile", keyFile: file }, { host: "127.0.0.1", port: echo.port }));
    expect(e.kind).toBe("key");
    expect(e.message).toBe(`Cannot read the SSH key file ${file}: PPM is not allowed to read it`);
  });
});
