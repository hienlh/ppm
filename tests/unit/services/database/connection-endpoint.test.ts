/**
 * How a connection's tunnel and certificate files reach the services, which only take a URL. What
 * is pinned: a connection that is not a saved one, with neither, keeps its URL byte for byte; the
 * parameter PPM adds never reaches a driver; the same settings of the same connection always name
 * the same pools, a changed secret new ones, and another saved connection — a Duplicate — others;
 * and a setting that cannot be used says so rather than connecting some other way.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeEndpoint, ENDPOINT_PARAM, endpointProfile, endpointSshHops, readCertificateFiles, serviceConnectionString, takeEndpoint,
  type EndpointConfig,
} from "../../../../src/services/database/connection-endpoint.ts";
import type { SshTunnelSettings } from "../../../../src/shared/db-connection-config.ts";

/** Outside the PPM directory, which the certificate reader refuses. */
const certs = mkdtempSync(join(tmpdir(), "ppm-endpoint-certs-"));
beforeAll(() => {
  writeFileSync(join(certs, "ca.pem"), "CA");
  writeFileSync(join(certs, "client.crt"), "CERT");
  writeFileSync(join(certs, "client.key"), "KEY");
});
afterAll(() => rmSync(certs, { recursive: true, force: true }));

const ssh: SshTunnelSettings = { enabled: true, host: "ssh.example.com", auth: "password", user: "deploy", password: "pw" };
const pg = (connectionString: string, extra: Partial<Extract<EndpointConfig, { type: "postgres" }>> = {}): EndpointConfig =>
  ({ type: "postgres", connectionString, ...extra });

function endpointIdOf(url: string): string | null {
  return new URL(url).searchParams.get(ENDPOINT_PARAM);
}

describe("a connection with neither", () => {
  it("keeps its URL byte for byte, even one PPM cannot read", () => {
    for (const cs of ["postgres://app:p%40ss@db.example.com:6543/shop?sslmode=require&application_name=x", "postgres://h:5432:5433/db", "  postgres://h/db"]) {
      expect(serviceConnectionString(pg(cs))).toBe(cs);
    }
    expect(serviceConnectionString({ type: "mysql", connectionString: "mysql://root@h/shop?ssl-mode=REQUIRED" })).toBe("mysql://root@h/shop?ssl-mode=REQUIRED");
    expect(takeEndpoint("postgres://app@h/shop")).toEqual({ url: "postgres://app@h/shop", endpoint: null });
  });

  it("keeps it for a tunnel left unticked, and for files with SSL off", () => {
    expect(serviceConnectionString(pg("postgres://h/db", { ssh: { ...ssh, enabled: false } }))).toBe("postgres://h/db");
    expect(serviceConnectionString(pg("postgres://h/db", { ssh: { ...ssh, enabled: false, host: "", auth: "keyFile", keyFile: "id_rsa" } }))).toBe("postgres://h/db");
    expect(serviceConnectionString(pg("postgres://h/db?sslmode=disable", { ssl: { ca: "ca.pem" } }))).toBe("postgres://h/db?sslmode=disable");
    const files = { ca: join(certs, "ca.pem") };
    expect(serviceConnectionString(pg("postgres://h/db", { ssl: files }))).toBe("postgres://h/db");
    expect(serviceConnectionString(pg("postgres://h/db?sslmode=disable", { ssl: files }))).toBe("postgres://h/db?sslmode=disable");
    expect(serviceConnectionString({ type: "mysql", connectionString: "mysql://h/db?ssl-mode=DISABLED", ssl: files })).toBe("mysql://h/db?ssl-mode=DISABLED");
  });

  it("has no connection string for a SQLite file", () => {
    expect(() => serviceConnectionString({ type: "sqlite", path: "/data/app.db" })).toThrow("A SQLite connection has no connection string");
    expect(endpointProfile({ type: "sqlite", path: "/data/app.db" })).toBeNull();
  });
});

describe("a connection through a tunnel", () => {
  it("names its profile in a parameter the driver never sees", () => {
    const url = serviceConnectionString(pg("postgres://app:pw@localhost:5432/shop?sslmode=require", { ssh }));
    const id = endpointIdOf(url);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const taken = takeEndpoint(url);
    expect(taken.url).toBe("postgres://app:pw@localhost:5432/shop?sslmode=require");
    expect(taken.endpoint).toEqual({ id: id!, profile: { ssh }, target: { host: "localhost", port: 5432 } });
  });

  it("takes the database's port from the URL, or the engine's default", () => {
    expect(takeEndpoint(serviceConnectionString(pg("postgres://db/shop", { ssh }))).endpoint?.target).toEqual({ host: "db", port: 5432 });
    expect(takeEndpoint(serviceConnectionString({ type: "mysql", connectionString: "mysql://root@10.0.0.5/shop", ssh })).endpoint?.target)
      .toEqual({ host: "10.0.0.5", port: 3306 });
    expect(takeEndpoint(serviceConnectionString({ type: "mariadb", connectionString: "mariadb://root@[::1]:3307/shop", ssh })).endpoint?.target)
      .toEqual({ host: "::1", port: 3307 });
  });

  it("gives the same settings the same id, and a changed secret or a test of its own another", () => {
    const id = (config: EndpointConfig) => endpointIdOf(serviceConnectionString(config));
    const base = id(pg("postgres://a/one", { ssh }));
    // Two URLs through one tunnel share its session.
    expect(id(pg("postgres://b/two", { ssh }))).toBe(base);
    expect(id(pg("postgres://a/one", { ssh: { ...ssh, password: "changed" } }))).not.toBe(base);
    expect(id(pg("postgres://a/one", { ssh: { ...ssh, host: "other.example.com" } }))).not.toBe(base);
    expect(id(pg("postgres://a/one", { ssh, endpointScope: "probe-1" }))).not.toBe(base);
    expect(id(pg("postgres://a/one", { ssh, endpointScope: "probe-1" }))).not.toBe(id(pg("postgres://a/one", { ssh, endpointScope: "probe-2" })));
  });

  it("refuses an id it does not hold, rather than connecting straight to the server", () => {
    expect(() => takeEndpoint(`postgres://h/db?${ENDPOINT_PARAM}=AAAAAAAAAAAAAAAAAAAAAA`))
      .toThrow("PPM no longer holds this connection's tunnel settings. Open the connection again.");
  });

  it("refuses a socket, which would quietly connect locally", () => {
    expect(() => serviceConnectionString(pg("postgres://app@/shop?host=/var/run/postgresql", { ssh })))
      .toThrow("An SSH tunnel reaches the database by host and port, not through a socket.");
  });

  it("says which tab to fix when an imported connection's settings cannot be used", () => {
    expect(() => serviceConnectionString(pg("postgres://h/db", { ssh: { ...ssh, host: "" } })))
      .toThrow("This connection's SSH tunnel settings cannot be used: Enter the SSH host. Edit the connection to fix them.");
    expect(() => serviceConnectionString(pg("postgres://h/db?sslmode=require", { ssl: { ca: "ca.pem" } })))
      .toThrow("This connection's SSL settings cannot be used: Give the CA certificate as a full path on the PPM host, not ca.pem. Edit the connection to fix them.");
    expect(() => serviceConnectionString(pg("postgres://h/db", { ssh: "yes" as unknown as SshTunnelSettings })))
      .toThrow("This connection's SSH tunnel settings cannot be used: The SSH tunnel settings must be an object");
  });
});

describe("a saved connection", () => {
  it("gets a parameter of its own with neither, which the driver never sees", () => {
    const url = serviceConnectionString(pg("postgres://app:pw@h:5432/shop?sslmode=prefer", { connectionId: 7 }));
    expect(endpointIdOf(url)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const taken = takeEndpoint(url);
    expect(taken.url).toBe("postgres://app:pw@h:5432/shop?sslmode=prefer");
    expect(taken.endpoint?.profile).toEqual({});
    expect(takeEndpoint(serviceConnectionString({ type: "mysql", connectionString: "mysql://root@h/shop", connectionId: 7 })).url).toBe("mysql://root@h/shop");
  });

  it("never shares pools or a tunnel with another one that has the same settings", () => {
    const id = (config: EndpointConfig) => endpointIdOf(serviceConnectionString(config));
    for (const extra of [{}, { ssh }]) {
      const original = id(pg("postgres://a/one", { ...extra, connectionId: 1 }));
      expect(id(pg("postgres://a/one", { ...extra, connectionId: 1 }))).toBe(original);
      expect(id(pg("postgres://a/one", { ...extra, connectionId: 2 }))).not.toBe(original);
      expect(id(pg("postgres://a/one", { ...extra }))).not.toBe(original);
    }
  });

  it("keeps a URL PPM cannot read as it is, there being nothing to add the parameter to", () => {
    expect(serviceConnectionString(pg("postgres://h:5432:5433/db", { connectionId: 7 }))).toBe("postgres://h:5432:5433/db");
  });
});

describe("certificate files", () => {
  it("are part of the profile with SSL on, and read afresh", () => {
    const files = { ca: join(certs, "ca.pem"), cert: join(certs, "client.crt"), key: join(certs, "client.key"), keyPassword: "kp" };
    const { endpoint } = takeEndpoint(serviceConnectionString(pg("postgres://h/db?sslmode=verify-full", { ssl: files })));
    expect(endpoint?.profile).toEqual({ ssl: files });
    expect(readCertificateFiles(files)).toEqual({ ca: Buffer.from("CA"), cert: Buffer.from("CERT"), key: Buffer.from("KEY"), passphrase: "kp" });
    writeFileSync(join(certs, "ca.pem"), "NEW CA");
    expect(readCertificateFiles({ ca: files.ca })).toEqual({ ca: Buffer.from("NEW CA") });
    expect(() => readCertificateFiles({ key: join(certs, "missing.key") })).toThrow(`Cannot read the key file ${join(certs, "missing.key")}: no such file on the PPM host`);
  });
});

describe("closing", () => {
  it("forgets a test's own profile, and keeps a saved connection's", () => {
    const scoped = pg("postgres://h/db", { ssh, endpointScope: "probe-close" });
    const scopedUrl = serviceConnectionString(scoped);
    closeEndpoint(scoped);
    expect(() => takeEndpoint(scopedUrl)).toThrow("PPM no longer holds");

    const saved = pg("postgres://h/db", { ssh });
    const savedUrl = serviceConnectionString(saved);
    closeEndpoint(saved);
    expect(takeEndpoint(savedUrl).endpoint).not.toBeNull();
  });

  it("does nothing for a connection with no tunnel, or one whose settings cannot be read", () => {
    expect(() => closeEndpoint(pg("postgres://h/db"))).not.toThrow();
    expect(() => closeEndpoint(pg("postgres://h/db", { ssh: { ...ssh, host: "" } }))).not.toThrow();
    expect(() => closeEndpoint({ type: "sqlite", path: "/data/app.db" })).not.toThrow();
  });

  it("reports no hops for a tunnel that is not open, or no tunnel", () => {
    expect(endpointSshHops(pg("postgres://h/db", { ssh }))).toBeNull();
    expect(endpointSshHops(pg("postgres://h/db"))).toBeNull();
  });
});
