/**
 * The SSH Tunnel and SSL tabs on their way into `ppm.db`, and back out to the edit form. What is
 * pinned: each refusal names the field it is about, only the chosen login method's secret is
 * stored, a secret left empty is the saved one only for the same method, a client that sends no
 * tunnel does not remove one, and no secret is ever sent back.
 */
import { describe, expect, it } from "bun:test";
import {
  ConnectionConfigError, editableConfig, normalizeConnectionConfig, readSshTunnelSettings, readSslFileSettings,
} from "../../../../src/services/database/connection-config.ts";
import type { SshTunnelSettings, StoredConnectionConfig } from "../../../../src/shared/db-connection-config.ts";

function refused(fn: () => unknown): ConnectionConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConnectionConfigError) return e;
    throw e;
  }
  throw new Error("expected a ConnectionConfigError");
}

const tunnel = (extra: Record<string, unknown> = {}) => ({ enabled: true, host: "ssh.example.com", auth: "password", user: "deploy", ...extra });

describe("readSshTunnelSettings", () => {
  it("stores what the tab says, trimmed, with the default port left out", () => {
    expect(readSshTunnelSettings(tunnel({ host: " ssh.example.com ", user: " deploy ", port: 22, password: " pw " }))).toEqual({
      enabled: true, host: "ssh.example.com", auth: "password", user: "deploy", password: " pw ",
    });
    expect(readSshTunnelSettings(tunnel({ port: "2222", bastionHost: " ops@jump:2200 " }))).toEqual({
      enabled: true, host: "ssh.example.com", auth: "password", user: "deploy", port: 2222, bastionHost: "ops@jump:2200",
    });
    // A login left empty is the user PPM runs as, which is decided when the tunnel opens.
    expect(readSshTunnelSettings(tunnel({ user: "", auth: "agent" }))).toEqual({ enabled: true, host: "ssh.example.com", auth: "agent", user: "" });
  });

  it("stores only the secret the chosen method uses", () => {
    expect(readSshTunnelSettings(tunnel({ auth: "agent", password: "pw", passphrase: "pp" }))).toEqual({
      enabled: true, host: "ssh.example.com", auth: "agent", user: "deploy",
    });
    expect(readSshTunnelSettings(tunnel({ auth: "keyFile", keyFile: "/home/me/.ssh/id_ed25519", password: "pw", passphrase: "pp" }))).toEqual({
      enabled: true, host: "ssh.example.com", auth: "keyFile", user: "deploy", keyFile: "/home/me/.ssh/id_ed25519", passphrase: "pp",
    });
    expect(readSshTunnelSettings(tunnel({ auth: "password", keyFile: "~/.ssh/id_rsa", password: "pw", passphrase: "pp" }))).toEqual({
      enabled: true, host: "ssh.example.com", auth: "password", user: "deploy", keyFile: "~/.ssh/id_rsa", password: "pw",
    });
  });

  it("keeps a saved secret for a field left empty, only when asked to and only for the same method", () => {
    const saved: SshTunnelSettings = { enabled: true, host: "old.example.com", auth: "password", user: "deploy", password: "old" };
    expect(readSshTunnelSettings(tunnel({ password: "" }), saved, true)?.password).toBe("old");
    // The host changed and the password stays, as the database password does.
    expect(readSshTunnelSettings(tunnel({ host: "new.example.com" }), saved, true)?.password).toBe("old");
    expect(readSshTunnelSettings(tunnel({ password: "typed" }), saved, true)?.password).toBe("typed");
    expect(readSshTunnelSettings(tunnel(), saved, false)?.password).toBeUndefined();

    const withKey: SshTunnelSettings = { enabled: true, host: "h", auth: "keyFile", user: "u", keyFile: "/k", passphrase: "pp" };
    expect(readSshTunnelSettings(tunnel({ auth: "keyFile", keyFile: "/k" }), withKey, true)?.passphrase).toBe("pp");
    // Another method: the old secret is not carried over to it.
    expect(readSshTunnelSettings(tunnel({ auth: "keyFile", keyFile: "/k" }), saved, true)).not.toHaveProperty("passphrase");
    expect(readSshTunnelSettings(tunnel({ auth: "password" }), withKey, true)).not.toHaveProperty("password");
  });

  it("keeps settings typed with the box unticked, and stores nothing when nothing was typed", () => {
    expect(readSshTunnelSettings({ enabled: false, host: "ssh.example.com", auth: "password", user: "" })).toEqual({
      enabled: false, host: "ssh.example.com", auth: "password", user: "",
    });
    // Unticked, a half-filled tab is not refused: it is not used, and its fields cannot be edited.
    expect(readSshTunnelSettings({ enabled: false, host: "", auth: "keyFile", user: "" })).toEqual({ enabled: false, host: "", auth: "keyFile", user: "" });
    expect(readSshTunnelSettings({ enabled: false, host: "h", auth: "keyFile", user: "", keyFile: "id_rsa" })?.keyFile).toBe("id_rsa");
    // Nor is a key file kept for another method.
    expect(readSshTunnelSettings(tunnel({ auth: "agent", keyFile: "id_rsa" }))?.keyFile).toBe("id_rsa");
    // A port that cannot be one is dropped: there is no number to keep, and nothing to fix it in.
    expect(readSshTunnelSettings({ enabled: false, host: "h", auth: "password", user: "", port: "22a" })).toEqual({ enabled: false, host: "h", auth: "password", user: "" });
    expect(readSshTunnelSettings({ enabled: false, host: "h", auth: "password", user: "", port: "2222" })?.port).toBe(2222);
    expect(readSshTunnelSettings({ enabled: false, host: "", auth: "password", user: "", password: "" })).toBeUndefined();
    expect(readSshTunnelSettings({})).toBeUndefined();
    expect(readSshTunnelSettings(undefined)).toBeUndefined();
    expect(readSshTunnelSettings(null)).toBeUndefined();
  });

  it("says which field is wrong", () => {
    const cases: [Record<string, unknown> | string, string, string][] = [
      ["on", "sshEnabled", "The SSH tunnel settings must be an object"],
      [tunnel({ enabled: "yes" }), "sshEnabled", "Use SSH tunnel must be on or off"],
      [tunnel({ host: 22 }), "sshHost", "The SSH host must be text"],
      [tunnel({ host: " " }), "sshHost", "Enter the SSH host."],
      [tunnel({ host: "deploy@ssh.example.com" }), "sshHost", "Enter the SSH host's name or address, like ssh.example.com. The login goes in its own field."],
      [tunnel({ host: "ssh example" }), "sshHost", "Enter the SSH host's name or address, like ssh.example.com. The login goes in its own field."],
      [tunnel({ host: "ssh://ssh.example.com" }), "sshHost", "Enter the SSH host's name or address, like ssh.example.com. The login goes in its own field."],
      [tunnel({ port: 0 }), "sshPort", "The SSH port must be a number from 1 to 65535."],
      [tunnel({ port: "65536" }), "sshPort", "The SSH port must be a number from 1 to 65535."],
      [tunnel({ port: "22a" }), "sshPort", "The SSH port must be a number from 1 to 65535."],
      [tunnel({ port: 22.5 }), "sshPort", "The SSH port must be a number from 1 to 65535."],
      [tunnel({ auth: "kerberos" }), "sshAuth", "SSH authentication must be one of password, agent, keyFile"],
      [tunnel({ user: ["root"] }), "sshUser", "The SSH login must be text"],
      [tunnel({ password: 1234 }), "sshPassword", "The SSH password must be text"],
      [tunnel({ bastionHost: "ssh://jump" }), "sshBastionHost", "Write the bastion as host or user@host:port, without ssh://."],
      [tunnel({ bastionHost: "jump:0" }), "sshBastionHost", "The bastion's port must be a number from 1 to 65535."],
      [tunnel({ auth: "keyFile" }), "sshKeyFile", "Pick the private key file."],
      [tunnel({ auth: "keyFile", keyFile: "id_ed25519" }), "sshKeyFile", "Give the key file as a full path on the PPM host, not id_ed25519."],
      [tunnel({ auth: "keyFile", keyFile: "/k", passphrase: false }), "sshPassphrase", "The key file passphrase must be text"],
    ];
    for (const [value, field, message] of cases) {
      const e = refused(() => readSshTunnelSettings(value));
      expect({ value, field: e.field, message: e.message }).toEqual({ value, field, message });
    }
  });
});

describe("readSslFileSettings", () => {
  it("stores the paths given, and the key's password only with a key", () => {
    expect(readSslFileSettings({ ca: " /etc/ssl/ca.pem ", cert: "", key: "", keyPassword: "pw" })).toEqual({ ca: "/etc/ssl/ca.pem" });
    expect(readSslFileSettings({ cert: "~/certs/client.crt", key: "~/certs/client.key", keyPassword: "pw" })).toEqual({
      cert: "~/certs/client.crt", key: "~/certs/client.key", keyPassword: "pw",
    });
    expect(readSslFileSettings({ ca: "", keyPassword: "" })).toBeUndefined();
    expect(readSslFileSettings(null)).toBeUndefined();
  });

  it("keeps the saved key password for a field left empty, only when asked to", () => {
    const saved = { key: "/k", keyPassword: "old" };
    expect(readSslFileSettings({ key: "/k" }, saved, true)).toEqual({ key: "/k", keyPassword: "old" });
    expect(readSslFileSettings({ key: "/k" }, saved, false)).toEqual({ key: "/k" });
    expect(readSslFileSettings({ ca: "/ca" }, saved, true)).toEqual({ ca: "/ca" });
  });

  it("checks the paths only when the URL turns TLS on, as the fields are only editable then", () => {
    expect(readSslFileSettings({ ca: "ca.pem", key: "client.key" }, undefined, false, false)).toEqual({ ca: "ca.pem", key: "client.key" });
    expect(normalizeConnectionConfig("postgres", { type: "postgres", connectionString: "postgres://h/db", ssl: { ca: "ca.pem" } }).ssl).toEqual({ ca: "ca.pem" });
    expect(refused(() => normalizeConnectionConfig("postgres", { type: "postgres", connectionString: "postgres://h/db?sslmode=require", ssl: { ca: "ca.pem" } })))
      .toMatchObject({ field: "sslCa", message: "Give the CA certificate as a full path on the PPM host, not ca.pem." });
    // A saved URL PPM cannot read might turn it on.
    const odd: StoredConnectionConfig = { type: "mysql", connectionString: "mysql://h:1:2/db" };
    expect(refused(() => normalizeConnectionConfig("mysql", { type: "mysql", ssl: { cert: "c.crt" } }, odd)).field).toBe("sslCert");
  });

  it("refuses a relative path, naming the field", () => {
    expect(refused(() => readSslFileSettings({ ca: "ca.pem" }))).toMatchObject({ field: "sslCa", message: "Give the CA certificate as a full path on the PPM host, not ca.pem." });
    expect(refused(() => readSslFileSettings({ cert: "./client.crt" }))).toMatchObject({ field: "sslCert", message: "Give the certificate as a full path on the PPM host, not ./client.crt." });
    expect(refused(() => readSslFileSettings({ key: "~client.key" }))).toMatchObject({ field: "sslKey", message: "Give the key file as a full path on the PPM host, not ~client.key." });
    expect(refused(() => readSslFileSettings({ key: "/k", keyPassword: 7 }))).toMatchObject({ field: "sslKeyPassword" });
    expect(refused(() => readSslFileSettings("yes")).field).toBe("sslCa");
  });
});

describe("normalizeConnectionConfig with a tunnel and certificate files", () => {
  const withTunnel: StoredConnectionConfig = {
    type: "postgres", connectionString: "postgres://app:pw@localhost/shop",
    ssh: { enabled: true, host: "ssh.example.com", auth: "password", user: "deploy", password: "sshpw" },
    ssl: { ca: "/etc/ssl/ca.pem" },
  };

  it("stores both beside the URL", () => {
    expect(normalizeConnectionConfig("postgres", {
      type: "postgres", connectionString: "postgres://app:pw@localhost/shop?sslmode=verify-full",
      ssh: tunnel({ password: "sshpw" }), ssl: { ca: "/etc/ssl/ca.pem" },
    })).toEqual({
      type: "postgres", connectionString: "postgres://app:pw@localhost/shop?sslmode=verify-full",
      ssh: { enabled: true, host: "ssh.example.com", auth: "password", user: "deploy", password: "sshpw" },
      ssl: { ca: "/etc/ssl/ca.pem" },
    });
  });

  it("keeps the saved tunnel when none is sent, and removes it when asked to", () => {
    const kept = normalizeConnectionConfig("postgres", { type: "postgres", isolationLevel: "SERIALIZABLE" }, withTunnel);
    expect(kept).toEqual({ ...withTunnel, isolationLevel: "SERIALIZABLE" });
    const removed = normalizeConnectionConfig("postgres", { type: "postgres", ssh: null, ssl: null }, withTunnel);
    expect(removed).toEqual({ type: "postgres", connectionString: "postgres://app:pw@localhost/shop" });
  });

  it("keeps the saved SSH password with the database password, when asked to", () => {
    const edited = normalizeConnectionConfig("postgres", {
      type: "postgres", connectionString: "postgres://app@localhost/shop", keepPassword: true, ssh: tunnel(), ssl: { ca: "/etc/ssl/ca.pem" },
    }, withTunnel);
    expect(edited).toEqual(withTunnel);
  });

  it("replaces a saved URL it cannot read with a new one whole, keeping the tunnel's password", () => {
    const odd: StoredConnectionConfig = { ...withTunnel, connectionString: "postgres://app:pw@h:5432:5433/shop" };
    // The form asks to keep secrets because the SSH password is saved; the old URL has none to give.
    expect(normalizeConnectionConfig("postgres", {
      type: "postgres", connectionString: "postgres://app@localhost/shop", keepPassword: true, ssh: tunnel(), ssl: { ca: "/etc/ssl/ca.pem" },
    }, odd)).toEqual({ ...withTunnel, connectionString: "postgres://app@localhost/shop" });
  });

  it("refuses a socket URL through a tunnel, which would quietly connect locally", () => {
    expect(refused(() => normalizeConnectionConfig("postgres", {
      type: "postgres", connectionString: "postgres://app@/shop?host=/var/run/postgresql", ssh: tunnel(),
    }))).toMatchObject({ field: "connectionString", message: expect.stringContaining("An SSH tunnel reaches the database by host and port.") });
    expect(refused(() => normalizeConnectionConfig("mysql", {
      type: "mysql", connectionString: "mysql://root@/shop?socket=/run/mysqld/mysqld.sock", ssh: tunnel(),
    })).field).toBe("connectionString");
    // With the box unticked the socket is used, and the tunnel's settings are kept for later.
    expect(normalizeConnectionConfig("postgres", {
      type: "postgres", connectionString: "postgres://app@/shop?host=/var/run/postgresql", ssh: tunnel({ enabled: false }),
    }).ssh?.enabled).toBe(false);
  });

  it("refuses a parameter PPM adds itself, in any case", () => {
    expect(refused(() => normalizeConnectionConfig("postgres", {
      type: "postgres", connectionString: "postgres://h/db?ppm-endpoint=abc",
    }))).toMatchObject({ field: "connectionString", message: "ppm-endpoint is a parameter PPM adds itself. Take it out of the URL." });
    expect(refused(() => normalizeConnectionConfig("mysql", { type: "mysql", connectionString: "mysql://h/db?PPM-Endpoint=abc" })).message)
      .toBe("PPM-Endpoint is a parameter PPM adds itself. Take it out of the URL.");
  });

  it("refuses to send a saved URL it cannot read through a tunnel", () => {
    const odd: StoredConnectionConfig = { type: "postgres", connectionString: "postgres://h:5432:5433/db" };
    expect(refused(() => normalizeConnectionConfig("postgres", { type: "postgres", ssh: tunnel() }, odd))).toMatchObject({
      field: "connectionString", message: expect.stringContaining("to send it through the SSH tunnel. Enter the URL again."),
    });
    // Unticked, nothing needs rewriting in it.
    expect(normalizeConnectionConfig("postgres", { type: "postgres", ssh: tunnel({ enabled: false }) }, odd).connectionString).toBe(odd.connectionString);
  });

  it("stores neither for a SQLite file", () => {
    expect(normalizeConnectionConfig("sqlite", { type: "sqlite", path: "/data/app.db", ssh: tunnel(), ssl: { ca: "/ca" } })).toEqual({ type: "sqlite", path: "/data/app.db" });
  });
});

describe("editableConfig with a tunnel and certificate files", () => {
  it("sends back no SSH password, passphrase or key password, only whether one is saved", () => {
    const edit = editableConfig({
      type: "postgres", connectionString: "postgres://app:dbsecret@localhost/shop",
      ssh: { enabled: true, host: "h", auth: "keyFile", user: "u", keyFile: "/k", passphrase: "keysecret", password: "leftover" },
      ssl: { key: "/client.key", keyPassword: "tlssecret" },
    });
    expect(edit).toEqual({
      type: "postgres", connectionString: "postgres://app@localhost/shop", hasPassword: true,
      ssh: { enabled: true, host: "h", auth: "keyFile", user: "u", keyFile: "/k", hasPassword: true, hasPassphrase: true },
      ssl: { key: "/client.key", hasKeyPassword: true },
    });
    for (const secret of ["dbsecret", "keysecret", "leftover", "tlssecret"]) expect(JSON.stringify(edit)).not.toContain(secret);
  });

  it("says none is saved, and strips them from a URL it cannot rebuild too", () => {
    const edit = editableConfig({
      type: "mysql", connectionString: "mysql://u:s@h:1:2/db",
      ssh: { enabled: false, host: "h", auth: "password", user: "", password: "sshsecret" },
      ssl: { ca: "/ca" },
    });
    expect(edit).toEqual({
      type: "mysql", connectionString: null, hasPassword: false,
      ssh: { enabled: false, host: "h", auth: "password", user: "", hasPassword: true, hasPassphrase: false },
      ssl: { ca: "/ca", hasKeyPassword: false },
    });
    expect(JSON.stringify(edit)).not.toContain("sshsecret");
  });
});
