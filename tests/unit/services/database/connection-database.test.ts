/**
 * Pointing a server connection at another of its databases: the URL is rebuilt with that
 * database and nothing else, the connection's own database keeps its URL byte for byte (and so
 * its pools), MySQL is told to list that database alone, a database outside the connection's
 * limit is refused, and the databases opened are handed to whoever closes the connection exactly
 * once.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  DatabaseTargetError, _resetOpenedDatabases, noteOpenedDatabase, ownDatabase, readDatabaseParam, takeOpenedDatabases,
  withDatabase,
} from "../../../../src/services/database/connection-database.ts";
import type { StoredConnectionConfig } from "../../../../src/shared/db-connection-config.ts";

afterEach(() => _resetOpenedDatabases());

const pg = (connectionString: string, extra: Partial<StoredConnectionConfig> = {}): StoredConnectionConfig =>
  ({ type: "postgres", connectionString, ...extra }) as StoredConnectionConfig;

describe("readDatabaseParam", () => {
  it("is undefined for none, and the name as given otherwise", () => {
    expect(readDatabaseParam(undefined)).toBeUndefined();
    expect(readDatabaseParam("")).toBeUndefined();
    expect(readDatabaseParam("shop staging")).toBe("shop staging");
  });

  it("refuses a name no server can have", () => {
    expect(() => readDatabaseParam("x".repeat(257))).toThrow(DatabaseTargetError);
    expect(() => readDatabaseParam("a\u0000b")).toThrow(DatabaseTargetError);
  });
});

describe("withDatabase", () => {
  it("points a Postgres URL at the database, keeping the login, the parameters and the settings", () => {
    const config = pg("postgres://app:p%40ss@db.example.com:6432/shop?sslmode=verify-full&application_name=ppm", {
      ssh: { enabled: true, host: "bastion", port: 22, auth: "agent", user: "u" }, singleDatabase: false,
    } as Partial<StoredConnectionConfig>);
    const target = withDatabase(config, "reporting");
    expect(target).toMatchObject({ type: "postgres", ssh: { enabled: true, host: "bastion" } });
    expect((target as { connectionString: string }).connectionString)
      .toBe("postgres://app:p%40ss@db.example.com:6432/reporting?sslmode=verify-full&application_name=ppm");
  });

  it("escapes a database name the URL cannot hold as it is", () => {
    const target = withDatabase(pg("postgres://app@db/shop", { singleDatabase: false } as Partial<StoredConnectionConfig>), "a/b?c#d");
    expect((target as { connectionString: string }).connectionString).toBe("postgres://app@db/a%2Fb%3Fc%23d");
  });

  it("gives a connection naming no database one", () => {
    const target = withDatabase(pg("postgres://app@db"), "shop");
    expect((target as { connectionString: string }).connectionString).toBe("postgres://app@db/shop");
  });

  it("keeps the connection's own database's URL byte for byte, so its pools are the same ones", () => {
    // A URL the builder would write differently: postgresql://, a port that is the default.
    const own = "postgresql://app@DB:5432/shop";
    expect(withDatabase(pg(own), "shop")).toEqual(pg(own));
  });

  it("has MySQL list that database alone", () => {
    const mysql = { type: "mysql", connectionString: "mysql://root@db/shop", singleDatabase: false } as StoredConnectionConfig;
    expect(withDatabase(mysql, "reporting")).toMatchObject({ connectionString: "mysql://root@db/reporting", singleDatabase: true });
    expect(withDatabase(mysql, "shop")).toMatchObject({ connectionString: "mysql://root@db/shop", singleDatabase: true });
  });

  it("refuses another database of a connection that uses only its own", () => {
    expect(() => withDatabase(pg("postgres://app@db/shop"), "reporting")).toThrow(new DatabaseTargetError('This connection uses only database "shop".'));
    expect(() => withDatabase(pg("postgres://app@db/shop", { singleDatabase: true } as Partial<StoredConnectionConfig>), "Shop")).toThrow(DatabaseTargetError);
    expect(withDatabase(pg("postgres://app@db/shop"), "shop")).toEqual(pg("postgres://app@db/shop"));
  });

  it("refuses a database outside the allowed list, by name ignoring case, never the connection's own", () => {
    const listed = (connectionString: string) =>
      pg(connectionString, { singleDatabase: false, allowedDatabases: [" Reporting ", "archive"], allowedDatabasesRegex: "^nothing$" } as Partial<StoredConnectionConfig>);
    expect(() => withDatabase(listed("postgres://app@db/shop"), "shop_staging"))
      .toThrow(new DatabaseTargetError('"shop_staging" is not one of this connection\'s allowed databases.'));
    expect(() => withDatabase(listed("postgres://app@db"), "shop")).toThrow(DatabaseTargetError);
    expect((withDatabase(listed("postgres://app@db/shop"), "REPORTING") as { connectionString: string }).connectionString).toBe("postgres://app@db/REPORTING");
    expect((withDatabase(listed("postgres://app@db/shop"), "archive") as { connectionString: string }).connectionString).toBe("postgres://app@db/archive");
    // Not in the list, and the URL's own all the same.
    expect(withDatabase(listed("postgres://app@db/shop"), "shop")).toEqual(listed("postgres://app@db/shop"));
    // The regular expression is not read here (see `filterAllowedDatabases`).
    expect(() => withDatabase(listed("postgres://app@db/shop"), "reporting")).not.toThrow();
  });

  it("refuses SQLite, which is one database, and a URL PPM cannot read", () => {
    expect(() => withDatabase({ type: "sqlite", path: "/tmp/a.db" }, "main")).toThrow(DatabaseTargetError);
    expect(() => withDatabase(pg("not a url"), "shop")).toThrow(/cannot read this connection's URL/);
  });
});

describe("ownDatabase", () => {
  it("is the database the URL names, or null", () => {
    expect(ownDatabase(pg("postgres://app@db/shop"))).toBe("shop");
    expect(ownDatabase(pg("postgres://app@db"))).toBeNull();
    expect(ownDatabase({ type: "sqlite", path: "/tmp/a.db" })).toBeNull();
    expect(ownDatabase(pg("not a url"))).toBeNull();
  });
});

describe("the databases a connection opened", () => {
  it("are handed over once, each once, per connection", () => {
    noteOpenedDatabase(1, "reporting");
    noteOpenedDatabase(1, "reporting");
    noteOpenedDatabase(1, "shop_staging");
    noteOpenedDatabase(2, "other");
    expect(takeOpenedDatabases(1).sort()).toEqual(["reporting", "shop_staging"]);
    expect(takeOpenedDatabases(1)).toEqual([]);
    expect(takeOpenedDatabases(2)).toEqual(["other"]);
  });
});
