/**
 * The one reader and writer of database URLs, shared by the connection form, the server and the CLI.
 * A URL goes in, the parts come out, and building them again must name the same connection.
 */
import { describe, expect, it } from "bun:test";
import {
  buildDbUrl, dbUrlProblem, dbUrlTarget, describeDbUrl, emptyDbUrlParts, parseDbUrl, sslFlags, withSslFlags,
  type DbUrlParts,
} from "../../../src/shared/db-connection-url.ts";

function parts(url: string): DbUrlParts {
  const result = parseDbUrl(url);
  if (result.kind !== "url") throw new Error(`expected a URL, got ${JSON.stringify(result)}`);
  return result.parts;
}

describe("parseDbUrl", () => {
  it("reads a MySQL URL with an encoded password, a port and ssl-mode", () => {
    const p = parts("mysql://u:p%40x@h:3307/db?ssl-mode=REQUIRED");
    expect(p).toMatchObject({ type: "mysql", host: "h", port: 3307, user: "u", password: "p@x", database: "db", socket: "" });
    expect(sslFlags(p)).toEqual({ useSsl: true, rejectUnauthorized: false });
  });

  it("reads libpq's socket form: a login, no host, the directory in ?host=", () => {
    const p = parts("postgres://app@/shop?host=/var/run/postgresql");
    expect(p).toMatchObject({ type: "postgres", host: "", socket: "/var/run/postgresql", user: "app", database: "shop", port: null });
    expect(p.params).toEqual([]);
  });

  it("reads a socket named as a percent-encoded host, as libpq also allows", () => {
    expect(parts("postgresql://%2Fvar%2Frun%2Fpostgresql/shop")).toMatchObject({ host: "", socket: "/var/run/postgresql", database: "shop" });
  });

  it("reads MySQL's ?socket=", () => {
    expect(parts("mysql://root@/shop?socket=/run/mysqld/mysqld.sock")).toMatchObject({ host: "", socket: "/run/mysqld/mysqld.sock", user: "root" });
  });

  it("keeps a URL's own words: the scheme, the TLS parameter and every other parameter", () => {
    const p = parts("postgresql://u@db.example.com/app?application_name=ppm&sslmode=prefer&connect_timeout=5");
    expect(p.scheme).toBe("postgresql");
    expect(p.ssl).toEqual({ name: "sslmode", value: "prefer" });
    expect(p.params).toEqual([["application_name", "ppm"], ["connect_timeout", "5"]]);
    expect(sslFlags(p)).toEqual({ useSsl: false, rejectUnauthorized: false });
  });

  it("takes an unencoded @ in the password as part of the password", () => {
    expect(parts("mariadb://root:p@ss@10.0.0.5/x")).toMatchObject({ type: "mariadb", user: "root", password: "p@ss", host: "10.0.0.5" });
  });

  it("reads an IPv6 host in brackets, and refuses a colon anywhere else in a host", () => {
    expect(parts("postgres://u@[::1]:6543/db")).toMatchObject({ host: "::1", port: 6543 });
    // Taken apart at the last colon, `h:1:2` would be host `h:1` on port 2, rebuilt as `[h:1]:2`.
    expect(parseDbUrl("postgres://u:pw@h:1:2/db")).toEqual({
      kind: "error", error: "The server name has a colon in it. An IPv6 address goes in brackets, like [::1]:5432.",
    });
  });

  it("reads a URL with no path and no login", () => {
    expect(parts("mysql://db.internal")).toMatchObject({ host: "db.internal", user: "", password: "", database: "", port: null });
  });

  it("says why it cannot read something", () => {
    expect(parseDbUrl("")).toEqual({ kind: "empty" });
    expect(parseDbUrl("   ")).toEqual({ kind: "empty" });
    expect(parseDbUrl("mongodb://h/db")).toEqual({ kind: "error", error: "mongodb:// is not a database PPM supports yet." });
    expect(parseDbUrl("postgres://h:99999/db")).toEqual({ kind: "error", error: "The port must be a number from 1 to 65535." });
    expect(parseDbUrl("postgres://h:54x/db")).toEqual({ kind: "error", error: "The port must be a number from 1 to 65535." });
    expect(parseDbUrl("host=localhost dbname=shop")).toEqual({ kind: "error", error: "PPM cannot read this as a URL." });
  });

  it("recognises a file path, so the form can point at SQLite", () => {
    for (const path of ["/home/me/app.db", "~/data/x.sqlite", "./a.db", "C:\\data\\app.sqlite3", "reports.db"]) {
      expect(parseDbUrl(path)).toEqual({ kind: "file", path });
    }
    expect(parseDbUrl("file:///tmp/a.db")).toEqual({ kind: "file", path: "/tmp/a.db" });
    // A server URL whose database happens to end in .db is still a server URL.
    expect(parseDbUrl("mysql://h/app.db").kind).toBe("url");
  });

  it("finds a URL with no server name to complain about", () => {
    expect(dbUrlProblem(parts("postgres:///shop"))).toBe("The URL has no server name.");
    expect(dbUrlProblem(parts("postgres://app@/shop?host=/var/run/postgresql"))).toBeNull();
    expect(dbUrlProblem(parts("mysql://h/db"))).toBeNull();
  });
});

describe("buildDbUrl", () => {
  it("round-trips every URL above to the same connection", () => {
    for (const url of [
      "mysql://u:p%40x@h:3307/db?ssl-mode=REQUIRED",
      "postgres://app@/shop?host=/var/run/postgresql",
      "mysql://root@/shop?socket=/run/mysqld/mysqld.sock",
      "postgresql://u@db.example.com/app?application_name=ppm&sslmode=prefer&connect_timeout=5",
      "mariadb://root:p@ss@10.0.0.5/x",
      "postgres://u@[::1]:6543/db",
      "postgres://a:b@h1:5432,h2:5433/db",
    ]) {
      const once = parts(url);
      expect(parts(buildDbUrl(once))).toEqual(once);
    }
  });

  it("encodes what would otherwise end the login early", () => {
    const p = { ...emptyDbUrlParts("postgres"), host: "h", user: "me@corp", password: "a/b?c#d:e@f", database: "my db" };
    const url = buildDbUrl(p);
    expect(url).toBe("postgres://me%40corp:a%2Fb%3Fc%23d%3Ae%40f@h/my%20db");
    expect(parts(url)).toEqual(p);
  });

  it("writes libpq's socket form for Postgres and ?socket= for MySQL, with the path readable", () => {
    expect(buildDbUrl({ ...emptyDbUrlParts("postgres"), socket: "/var/run/postgresql", user: "app", database: "shop" }))
      .toBe("postgres://app@/shop?host=/var/run/postgresql");
    expect(buildDbUrl({ ...emptyDbUrlParts("mysql"), socket: "/run/mysqld/mysqld.sock", user: "root" }))
      .toBe("mysql://root@/?socket=/run/mysqld/mysqld.sock");
  });

  it("leaves the password out when asked, which is all the browser is ever shown", () => {
    expect(buildDbUrl(parts("mysql://u:secret@h:3307/db"), { password: false })).toBe("mysql://u@h:3307/db");
    expect(buildDbUrl(parts("postgres://:secret@h/db"), { password: false })).toBe("postgres://h/db");
  });
});

describe("the SSL checkboxes", () => {
  it("read verify-* as Reject unauthorized, in either engine's spelling", () => {
    expect(sslFlags(parts("postgres://h/db?sslmode=verify-full"))).toEqual({ useSsl: true, rejectUnauthorized: true });
    expect(sslFlags(parts("postgres://h/db?sslmode=verify-ca"))).toEqual({ useSsl: true, rejectUnauthorized: true });
    expect(sslFlags(parts("mysql://h/db?ssl-mode=VERIFY_IDENTITY"))).toEqual({ useSsl: true, rejectUnauthorized: true });
    expect(sslFlags(parts("postgres://h/db?sslmode=disable"))).toEqual({ useSsl: false, rejectUnauthorized: false });
    expect(sslFlags(parts("postgres://h/db"))).toEqual({ useSsl: false, rejectUnauthorized: false });
  });

  it("write each engine's own spelling when changed", () => {
    const pg = withSslFlags(parts("postgres://h/db"), true, true);
    expect(buildDbUrl(pg)).toBe("postgres://h/db?sslmode=verify-full");
    expect(buildDbUrl(withSslFlags(pg, true, false))).toBe("postgres://h/db?sslmode=require");
    expect(buildDbUrl(withSslFlags(pg, false, true))).toBe("postgres://h/db");
    expect(buildDbUrl(withSslFlags(parts("mysql://h/db"), true, false))).toBe("mysql://h/db?ssl-mode=REQUIRED");
  });

  it("keep a URL's own spelling when they say what it already says", () => {
    const p = parts("mysql://h/db?sslmode=verify_ca");
    expect(withSslFlags(p, true, true)).toBe(p);
    const prefer = parts("postgres://h/db?sslmode=prefer");
    expect(withSslFlags(prefer, false, false)).toBe(prefer);
  });
});

describe("describing a URL", () => {
  it("says what was read, without the password", () => {
    expect(describeDbUrl(parts("mysql://u:p%40x@h:3307/db?ssl-mode=REQUIRED")))
      .toBe("MySQL · h:3307 · user u · password set · database db · SSL");
    expect(describeDbUrl(parts("postgres://app@/shop?host=/var/run/postgresql")))
      .toBe("PostgreSQL · socket /var/run/postgresql · user app · database shop");
    expect(describeDbUrl(parts("mariadb://db.internal"))).toBe("MariaDB · db.internal:3306 · all databases");
    expect(dbUrlTarget(parts("postgres://h/db"))).toBe("h:5432");
  });
});
