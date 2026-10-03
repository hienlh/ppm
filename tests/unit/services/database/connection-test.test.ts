/**
 * What the connection form's Test says when it fails. The message is the driver's own; the
 * details carry the code, the address and login that were tried, and the machine the attempt
 * came from — and never the password, even when a driver repeats the URL it was given.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTION_TEST_TIMEOUT_MS, connectionTestTimeoutMs, errorCodeLine, errorHint, redactLogin, runConnectionTest, testFailureDetails,
} from "../../../../src/services/database/connection-test.ts";
import { initAdapters } from "../../../../src/services/database/init-adapters.ts";
import { localSshUser, SSH_FORWARD_TIMEOUT_MS, SSH_READY_TIMEOUT_MS, sshTunnelOpenBudgetMs, SshTunnelError } from "../../../../src/services/database/ssh-tunnel.ts";
import type { StoredConnectionConfig } from "../../../../src/shared/db-connection-config.ts";

initAdapters();

const dir = mkdtempSync(join(tmpdir(), "ppm-connection-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** postgres.js's error for a server's refusal: a PostgresError whose code is the SQLSTATE. */
const pgRefusal = Object.assign(new Error('password authentication failed for user "app"'), { name: "PostgresError", code: "28P01", severity: "FATAL" });
/** mysql2's: a code, an errno and a SQLSTATE. */
const mysqlRefusal = Object.assign(new Error("Access denied for user 'root'@'172.17.0.1' (using password: YES)"), {
  code: "ER_ACCESS_DENIED_ERROR", errno: 1045, sqlState: "28000",
});
const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED", errno: -111 });

describe("errorCodeLine", () => {
  it("names a Postgres SQLSTATE", () => {
    expect(errorCodeLine(pgRefusal)).toBe("SQLSTATE 28P01 (invalid_password)");
    expect(errorCodeLine(Object.assign(new Error("x"), { name: "PostgresError", code: "XX000" }))).toBe("SQLSTATE XX000");
  });

  it("gives MySQL's code, errno and SQLSTATE", () => {
    expect(errorCodeLine(mysqlRefusal)).toBe("ER_ACCESS_DENIED_ERROR · errno 1045 · SQLSTATE 28000");
  });

  it("gives a network error's code, and nothing for an error without one", () => {
    expect(errorCodeLine(refused)).toBe("Code: ECONNREFUSED");
    // Five capital letters, like a SQLSTATE, but not from the server.
    expect(errorCodeLine(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe("Code: EPIPE");
    expect(errorCodeLine(new Error("plain"))).toBeNull();
  });
});

describe("errorHint", () => {
  it("explains a server that does not do TLS, for both drivers", () => {
    expect(errorHint(new Error("Client network socket disconnected before secure TLS connection was established"))).toContain("does not accept an encrypted connection");
    expect(errorHint(Object.assign(new Error("Server does not support secure connection"), { code: "HANDSHAKE_NO_SSL_SUPPORT" }))).toContain("does not accept an encrypted connection");
  });

  it("explains a certificate that was not accepted", () => {
    expect(errorHint(new Error("self-signed certificate in certificate chain"))).toContain("certificate was not accepted");
    expect(errorHint(refused)).toBeNull();
  });

  it("gives a tunnel failure's own hint", () => {
    expect(errorHint(new SshTunnelError("auth", "refused", "Check the login and the credentials on the SSH Tunnel tab."))).toBe("Check the login and the credentials on the SSH Tunnel tab.");
    expect(errorHint(new SshTunnelError("network", "no route"))).toBeNull();
  });
});

describe("connectionTestTimeoutMs", () => {
  it("adds each SSH hop's login and connect, so the tunnel's error is what gets shown", () => {
    const ssh = { enabled: true, host: "h", auth: "agent", user: "" } as const;
    expect(connectionTestTimeoutMs({ type: "postgres", connectionString: "postgres://h/db" })).toBe(CONNECTION_TEST_TIMEOUT_MS);
    expect(connectionTestTimeoutMs({ type: "postgres", connectionString: "postgres://h/db", ssh: { ...ssh, enabled: false } })).toBe(CONNECTION_TEST_TIMEOUT_MS);
    expect(connectionTestTimeoutMs({ type: "postgres", connectionString: "postgres://h/db", ssh })).toBe(CONNECTION_TEST_TIMEOUT_MS + SSH_READY_TIMEOUT_MS + SSH_FORWARD_TIMEOUT_MS);
    expect(connectionTestTimeoutMs({ type: "mysql", connectionString: "mysql://h/db", ssh: { ...ssh, bastionHost: "jump" } }))
      .toBe(CONNECTION_TEST_TIMEOUT_MS + 2 * (SSH_READY_TIMEOUT_MS + SSH_FORWARD_TIMEOUT_MS));
    expect(connectionTestTimeoutMs({ type: "sqlite", path: "/a.db" })).toBe(CONNECTION_TEST_TIMEOUT_MS);
    expect(sshTunnelOpenBudgetMs(undefined)).toBe(0);
    expect(sshTunnelOpenBudgetMs({ ...ssh, enabled: false })).toBe(0);
  });
});

describe("testFailureDetails", () => {
  it("lists the code, the server, the login and where the attempt came from, without the password", () => {
    const config: StoredConnectionConfig = { type: "postgres", connectionString: "postgres://app:hunter2@db.example.com:6543/shop?sslmode=verify-full" };
    const details = testFailureDetails(config, pgRefusal);
    expect(details.split("\n")).toEqual([
      "SQLSTATE 28P01 (invalid_password)",
      "Server: db.example.com:6543 (PostgreSQL)",
      "User: app",
      "SSL: sslmode=verify-full",
      `Checked from the PPM host (${hostname()}).`,
    ]);
    expect(details).not.toContain("hunter2");
  });

  it("says who logs in where through the tunnel, and that the server is as the SSH server sees it", () => {
    const config: StoredConnectionConfig = {
      type: "postgres", connectionString: "postgres://app:hunter2@localhost/shop?sslmode=verify-full",
      ssh: { enabled: true, host: "ssh.example.com", port: 2222, auth: "keyFile", user: "deploy", keyFile: "/home/me/.ssh/id_ed25519", passphrase: "sesame42", bastionHost: "ops@jump:2200" },
      ssl: { ca: "/etc/ssl/ca.pem", key: "/etc/ssl/client.key", keyPassword: "tlspass1" },
    };
    const details = testFailureDetails(config, refused);
    expect(details.split("\n")).toEqual([
      "Code: ECONNREFUSED",
      "Server: localhost:5432 (PostgreSQL), as the SSH server sees it",
      "User: app",
      "SSL: sslmode=verify-full",
      "SSL files: CA certificate /etc/ssl/ca.pem, key file /etc/ssl/client.key",
      "SSH: deploy@ssh.example.com:2222 with key file /home/me/.ssh/id_ed25519",
      "Bastion: ops@jump:2200",
      `Checked from the PPM host (${hostname()}).`,
    ]);
    for (const secret of ["hunter2", "sesame42", "tlspass1"]) expect(details).not.toContain(secret);
  });

  it("names the user PPM runs as when the SSH login is empty, for the bastion too", () => {
    const details = testFailureDetails({
      type: "mysql", connectionString: "mysql://root@db/shop",
      ssh: { enabled: true, host: "ssh.example.com", auth: "agent", user: "", bastionHost: "jump" },
    }, refused);
    expect(details).toContain(`SSH: ${localSshUser()} (the user PPM runs as)@ssh.example.com:22 with SSH agent`);
    expect(details).toContain(`Bastion: ${localSshUser()}@jump:22`);
    // A tunnel left unticked is not where the attempt went.
    const direct = testFailureDetails({ type: "mysql", connectionString: "mysql://root@db/shop", ssh: { enabled: false, host: "ssh.example.com", auth: "agent", user: "" } }, refused);
    expect(direct).not.toContain("SSH");
    expect(direct).toContain("Server: db:3306 (MySQL)\n");
  });

  it("names the default user and a socket", () => {
    const details = testFailureDetails({ type: "mysql", connectionString: "mysql://h/shop?socket=/run/mysqld/mysqld.sock" }, mysqlRefusal);
    expect(details).toContain("Server: socket /run/mysqld/mysqld.sock (MySQL)");
    expect(details).toContain("User: root (default)");
    expect(details).toContain("SSL: not set in the URL");
  });
});

describe("redactLogin", () => {
  it("takes the URL and its login out of a message that repeats them", () => {
    const config: StoredConnectionConfig = { type: "postgres", connectionString: "postgres://app:p@ss:w0rd@h:1:2/db" };
    expect(redactLogin(`"${config.connectionString}" cannot be parsed as a URL.`, config)).toBe('"<connection URL>" cannot be parsed as a URL.');
    const parsed: StoredConnectionConfig = { type: "postgres", connectionString: "postgres://app:p%40ss@h/db" };
    expect(redactLogin("tried postgres://app:p%40ss@other/db and postgres://app:p@ss@x", parsed)).toBe("tried postgres://app:•••@other/db and postgres://app:•••@x");
  });

  it("takes the SSH and key passwords out too, where they are long enough not to be a word", () => {
    const config: StoredConnectionConfig = {
      type: "postgres", connectionString: "postgres://h/db",
      ssh: { enabled: true, host: "h", auth: "password", user: "u", password: "tunnelpw", passphrase: "keyphrase" },
      ssl: { key: "/k", keyPassword: "tlskeypw" },
    };
    expect(redactLogin("tunnelpw keyphrase tlskeypw", config)).toBe("••• ••• •••");
    expect(redactLogin("the pw is in a word", { ...config, ssh: { ...config.ssh!, password: "pw" } } as StoredConnectionConfig)).toBe("the pw is in a word");
  });
});

describe("runConnectionTest", () => {
  it("opens a SQLite file and says which SQLite it is", async () => {
    const file = join(dir, "ok.db");
    const db = new Database(file);
    db.exec("CREATE TABLE t (id INTEGER)");
    db.close();
    const result = await runConnectionTest({ type: "sqlite", path: file });
    expect(result).toMatchObject({ ok: true, version: expect.stringMatching(/^SQLite 3\.\d+\.\d+$/), databases: [], target: file });
  });

  it("says a file is missing, or is not a database", async () => {
    const missing = await runConnectionTest({ type: "sqlite", path: join(dir, "nope.db") });
    expect(missing).toMatchObject({ ok: false, error: `File not found: ${join(dir, "nope.db")}` });
    const text = join(dir, "notes.txt");
    writeFileSync(text, "not a database, but long enough to fill a header page ".repeat(20));
    const notDb = await runConnectionTest({ type: "sqlite", path: text });
    expect(notDb.ok).toBe(false);
    expect(!notDb.ok && notDb.error).toContain("not a database");
    expect(!notDb.ok && notDb.details).toContain(`File: ${text}`);
  });

  it("reports a refused connection with its code, and not the password", async () => {
    const result = await runConnectionTest({ type: "postgres", connectionString: "postgres://app:hunter2@127.0.0.1:1/db" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.details).toContain("Code: ECONNREFUSED");
    expect(result.details).toContain("Server: 127.0.0.1:1 (PostgreSQL)");
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
});
