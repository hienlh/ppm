/**
 * What each driver is handed for a connection string. Both used to read the string with
 * `new URL()`, which refuses a socket URL (a login and no host); and the Postgres side handed
 * postgres.js `ssl: undefined` for `verify-full` and `verify-ca`, which connected in plain text.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerCertificate } from "node:tls";
import { serviceConnectionString } from "../../../../src/services/database/connection-endpoint.ts";
import { postgresConnectTarget, postgresSsl } from "../../../../src/services/database/postgres-connect-options.ts";
import { mysqlPoolOptions } from "../../../../src/services/mysql.service.ts";
import type { SshTunnelSettings } from "../../../../src/shared/db-connection-config.ts";

/** Outside the PPM directory, which the certificate reader refuses. */
const certs = mkdtempSync(join(tmpdir(), "ppm-connect-options-"));
afterAll(() => rmSync(certs, { recursive: true, force: true }));
const ca = join(certs, "ca.pem");
writeFileSync(ca, "CA");
const ssh: SshTunnelSettings = { enabled: true, host: "ssh.example.com", auth: "password", user: "deploy", password: "pw" };

/** Enough of a peer certificate for `tls.checkServerIdentity`. */
const certFor = (name: string) => ({ subject: { CN: name }, subjectaltname: `DNS:${name}` }) as unknown as PeerCertificate;

describe("postgresConnectTarget", () => {
  it("leaves TLS alone when the URL does not name it", () => {
    const target = postgresConnectTarget("postgres://u:p@db.example.com:6543/app");
    expect(target).toEqual({ url: "postgres://u:p@db.example.com:6543/app" });
    expect("ssl" in target).toBe(false);
  });

  it("checks the certificate for both verify modes, and the host name only for verify-full", () => {
    const full = postgresConnectTarget("postgres://h/db?sslmode=verify-full").ssl;
    expect(full).toEqual({ rejectUnauthorized: true });

    const ca = postgresConnectTarget("postgres://h/db?sslmode=verify-ca").ssl as { rejectUnauthorized: boolean; checkServerIdentity: () => unknown };
    expect(ca.rejectUnauthorized).toBe(true);
    expect(ca.checkServerIdentity()).toBeUndefined();
  });

  it("maps the other libpq modes onto postgres.js's own", () => {
    expect(postgresSsl("require")).toBe("require");
    expect(postgresSsl("no-verify")).toBe("require");
    expect(postgresSsl("prefer")).toBe("prefer");
    expect(postgresSsl("allow")).toBe("prefer");
    expect(postgresSsl("disable")).toBe(false);
    expect(postgresSsl("VERIFY-FULL")).toEqual({ rejectUnauthorized: true });
  });

  it("refuses a mode it does not know instead of guessing", () => {
    expect(() => postgresConnectTarget("postgres://h/db?sslmode=verify-everything")).toThrow('Unknown sslmode "verify-everything"');
  });

  it("gives a socket as the host option, with a URL postgres.js can read", () => {
    expect(postgresConnectTarget("postgres://app@/shop?host=/var/run/postgresql&application_name=ppm")).toEqual({
      url: "postgres://app@localhost/shop?application_name=ppm",
      host: "/var/run/postgresql",
    });
  });
});

describe("postgresConnectTarget through the SSH Tunnel and SSL tabs", () => {
  it("opens each connection's socket through the tunnel, with a URL that no longer names it", () => {
    const target = postgresConnectTarget(serviceConnectionString({ type: "postgres", connectionString: "postgres://app:pw@db.internal/shop", ssh }));
    expect(target.url).toBe("postgres://app:pw@db.internal/shop");
    expect(typeof target.socket).toBe("function");
    expect("ssl" in target).toBe(false);
    expect("socket" in postgresConnectTarget("postgres://app:pw@db.internal/shop")).toBe(false);
  });

  it("checks the certificate's name against the database's host, not the socket's", () => {
    const ssl = postgresConnectTarget(serviceConnectionString({
      type: "postgres", connectionString: "postgres://db.internal/shop?sslmode=verify-full", ssh,
    })).ssl as { rejectUnauthorized: boolean; checkServerIdentity: (name: string, cert: PeerCertificate) => Error | undefined };
    expect(ssl.rejectUnauthorized).toBe(true);
    // Whatever name TLS thinks it connected to, the database's is the one checked.
    expect(ssl.checkServerIdentity("127.0.0.1", certFor("db.internal"))).toBeUndefined();
    expect(ssl.checkServerIdentity("db.internal", certFor("ssh.example.com"))).toBeInstanceOf(Error);

    // verify-ca keeps not checking the name at all, and require checks nothing.
    const ca = postgresConnectTarget(serviceConnectionString({ type: "postgres", connectionString: "postgres://db.internal/shop?sslmode=verify-ca", ssh })).ssl as {
      checkServerIdentity: (name: string, cert: PeerCertificate) => Error | undefined;
    };
    expect(ca.checkServerIdentity("db.internal", certFor("anything"))).toBeUndefined();
    expect(postgresConnectTarget(serviceConnectionString({ type: "postgres", connectionString: "postgres://db.internal/shop?sslmode=require", ssh })).ssl).toBe("require");
  });

  it("adds the certificate files to what sslmode asks for", () => {
    const files = { ca };
    expect(postgresConnectTarget(serviceConnectionString({ type: "postgres", connectionString: "postgres://h/db?sslmode=require", ssl: files })).ssl)
      .toEqual({ rejectUnauthorized: false, ca: Buffer.from("CA") });
    expect(postgresConnectTarget(serviceConnectionString({ type: "postgres", connectionString: "postgres://h/db?sslmode=verify-full", ssl: files })).ssl)
      .toEqual({ rejectUnauthorized: true, ca: Buffer.from("CA") });
    // With TLS off the files are kept for later and not used.
    expect(postgresConnectTarget(serviceConnectionString({ type: "postgres", connectionString: "postgres://h/db?sslmode=disable", ssl: files })).ssl).toBe(false);
    expect(postgresConnectTarget(serviceConnectionString({ type: "postgres", connectionString: "postgres://h/db?sslmode=prefer", ssl: files })).ssl).toBe("prefer");
  });

  it("says a certificate file it cannot read, when the pool opens", () => {
    const url = serviceConnectionString({ type: "postgres", connectionString: "postgres://h/db?sslmode=require", ssl: { ca: join(certs, "gone.pem") } });
    expect(() => postgresConnectTarget(url)).toThrow(`Cannot read the CA certificate ${join(certs, "gone.pem")}: no such file on the PPM host`);
  });
});

describe("mysqlPoolOptions through the SSH Tunnel and SSL tabs", () => {
  it("joins each connection to a tunnel channel, keeping the database's host as the TLS server name", () => {
    const options = mysqlPoolOptions(serviceConnectionString({
      type: "mysql", connectionString: "mysql://root:pw@10.0.0.5:3307/shop?ssl-mode=VERIFY_IDENTITY", ssh, ssl: { ca },
    }));
    expect(options).toMatchObject({ host: "10.0.0.5", port: 3307, user: "root", password: "pw", database: "shop" });
    expect(typeof options.stream).toBe("function");
    expect(options.ssl).toEqual({ rejectUnauthorized: true, verifyIdentity: true, ca: Buffer.from("CA") });
  });

  it("uses the files with SSL on only, and opens no stream without a tunnel", () => {
    const required = mysqlPoolOptions(serviceConnectionString({ type: "mariadb", connectionString: "mariadb://root@h/shop?ssl-mode=REQUIRED", ssl: { ca } }));
    expect(required.ssl).toEqual({ rejectUnauthorized: false, ca: Buffer.from("CA") });
    expect("stream" in required).toBe(false);
    expect("ssl" in mysqlPoolOptions(serviceConnectionString({ type: "mysql", connectionString: "mysql://root@h/shop", ssl: { ca } }))).toBe(false);
  });
});

describe("mysqlPoolOptions", () => {
  it("reads a socket URL with a login and no host", () => {
    expect(mysqlPoolOptions("mysql://root:pw@/shop?socket=/run/mysqld/mysqld.sock")).toMatchObject({
      socketPath: "/run/mysqld/mysqld.sock", user: "root", password: "pw", database: "shop",
    });
  });

  it("reads an encoded password, an IPv6 host and ssl-mode", () => {
    const options = mysqlPoolOptions("mariadb://u:p%40x@[::1]:3307/db?ssl-mode=VERIFY_IDENTITY");
    expect(options).toMatchObject({ host: "::1", port: 3307, user: "u", password: "p@x", database: "db" });
    expect(options.ssl).toEqual({ rejectUnauthorized: true, verifyIdentity: true });
  });

  it("says what is wrong with a string it cannot read", () => {
    expect(() => mysqlPoolOptions("mysql://h:99999/db")).toThrow("The port must be a number from 1 to 65535.");
    expect(() => mysqlPoolOptions("postgres://h/db")).toThrow("A MySQL connection string starts with mysql://");
    expect(() => mysqlPoolOptions("mysql://h/db?ssl-mode=SOMETIMES")).toThrow('Unknown ssl-mode "SOMETIMES"');
  });
});
