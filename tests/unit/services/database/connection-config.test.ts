/**
 * What a connection form's config becomes on its way into `ppm.db`, and what goes back out to
 * the edit form. The two promises worth pinning: a password is never sent back, and one left
 * empty on a saved connection is kept rather than wiped.
 */
import { describe, expect, it } from "bun:test";
import {
  ConnectionConfigError, editableConfig, normalizeConnectionConfig, savedLoginUser, withLogin,
} from "../../../../src/services/database/connection-config.ts";
import { filterAllowedDatabases, type StoredConnectionConfig } from "../../../../src/shared/db-connection-config.ts";

const pg = (connectionString: string, extra: Record<string, unknown> = {}) => ({ type: "postgres", connectionString, ...extra });

function refused(fn: () => unknown): ConnectionConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConnectionConfigError) return e;
    throw e;
  }
  throw new Error("expected a ConnectionConfigError");
}

describe("normalizeConnectionConfig", () => {
  it("stores a server URL as given, trimmed, with default settings left out", () => {
    expect(normalizeConnectionConfig("postgres", pg("  postgresql://app:pw@db.example.com:6543/shop?sslmode=require  ", {
      passwordMode: "save", allowedDatabases: [], allowedDatabasesRegex: "  ", isolationLevel: "",
    }))).toEqual({ type: "postgres", connectionString: "postgresql://app:pw@db.example.com:6543/shop?sslmode=require" });
  });

  it("keeps the form's settings, checked and tidied", () => {
    expect(normalizeConnectionConfig("mysql", {
      type: "mysql", connectionString: "mysql://root@h/shop", entry: "fields", singleDatabase: false,
      allowedDatabases: [" shop ", "shop", "", "crm"], allowedDatabasesRegex: " ^sh ", isolationLevel: "serializable",
    })).toEqual({
      type: "mysql", connectionString: "mysql://root@h/shop", entry: "fields", singleDatabase: false,
      allowedDatabases: ["shop", "crm"], allowedDatabasesRegex: "^sh", isolationLevel: "SERIALIZABLE",
    });
  });

  it("keeps a query timeout in whole seconds, and none when it is left empty", () => {
    expect(normalizeConnectionConfig("postgres", pg("postgres://h/db", { queryTimeoutSec: 30 })).queryTimeoutSec).toBe(30);
    expect(normalizeConnectionConfig("mysql", { type: "mysql", connectionString: "mysql://h/db", queryTimeoutSec: " 86400 " })).toMatchObject({ queryTimeoutSec: 86_400 });
    for (const queryTimeoutSec of ["", null, undefined]) {
      expect("queryTimeoutSec" in normalizeConnectionConfig("postgres", pg("postgres://h/db", { queryTimeoutSec }))).toBe(false);
    }
  });

  it("says which field is wrong", () => {
    expect(refused(() => normalizeConnectionConfig("postgres", pg("postgres://h/db", { allowedDatabasesRegex: "(" }))))
      .toMatchObject({ field: "allowedDatabasesRegex", message: expect.stringContaining("Allowed databases regular expression:") });
    expect(refused(() => normalizeConnectionConfig("postgres", pg("postgres://h/db", { isolationLevel: "SNAPSHOT" }))).field).toBe("isolationLevel");
    expect(refused(() => normalizeConnectionConfig("postgres", pg("postgres://h/db", { passwordMode: "raw" }))).field).toBe("passwordMode");
    for (const queryTimeoutSec of [0, -1, 1.5, "1.5", "soon", 86_401, true]) {
      expect(refused(() => normalizeConnectionConfig("postgres", pg("postgres://h/db", { queryTimeoutSec })))).toMatchObject({
        field: "queryTimeoutSec", message: "The query timeout is a whole number of seconds from 1 to 86400, or empty for no limit",
      });
    }
    expect(refused(() => normalizeConnectionConfig("postgres", pg("postgres://h:0/db"))))
      .toMatchObject({ field: "connectionString", message: "The port must be a number from 1 to 65535." });
    expect(refused(() => normalizeConnectionConfig("sqlite", { type: "sqlite", path: " " })).field).toBe("path");
  });

  it("refuses a URL for another engine, a file path, and a URL with no server", () => {
    expect(refused(() => normalizeConnectionConfig("postgres", pg("mysql://root@h/db"))).message)
      .toBe("This is a MySQL URL, and the connection is PostgreSQL.");
    expect(refused(() => normalizeConnectionConfig("postgres", pg("/home/me/app.db"))).message).toContain("Choose SQLite");
    expect(refused(() => normalizeConnectionConfig("postgres", pg("postgres:///db"))).message).toBe("The URL has no server name.");
    expect(refused(() => normalizeConnectionConfig("postgres", { type: "mysql", connectionString: "mysql://h/db" })).field).toBe("type");
  });

  it("lets MySQL and MariaDB read each other's URLs", () => {
    expect(normalizeConnectionConfig("mariadb", { type: "mariadb", connectionString: "mysql://root@h:3307/db" }).type).toBe("mariadb");
  });

  it("keeps the saved password for a field left empty, and only when asked to", () => {
    const saved: StoredConnectionConfig = { type: "postgres", connectionString: "postgres://app:s%40cret@old-host/shop" };
    const kept = normalizeConnectionConfig("postgres", pg("postgres://app@new-host:5433/shop", { keepPassword: true }), saved);
    expect(kept).toEqual({ type: "postgres", connectionString: "postgres://app:s%40cret@new-host:5433/shop" });

    // A password typed in wins; without keepPassword an empty field means no password.
    expect(normalizeConnectionConfig("postgres", pg("postgres://app:new@h/shop", { keepPassword: true }), saved).connectionString)
      .toBe("postgres://app:new@h/shop");
    expect(normalizeConnectionConfig("postgres", pg("postgres://app@h/shop"), saved).connectionString).toBe("postgres://app@h/shop");
  });

  it("keeps the saved URL when none is sent, even one PPM cannot read", () => {
    const odd: StoredConnectionConfig = { type: "postgres", connectionString: "postgres://h:5432:5433/db" };
    expect(normalizeConnectionConfig("postgres", { type: "postgres", isolationLevel: "SERIALIZABLE" }, odd))
      .toEqual({ type: "postgres", connectionString: "postgres://h:5432:5433/db", isolationLevel: "SERIALIZABLE" });
    // ...but not once something in it has to change.
    expect(refused(() => normalizeConnectionConfig("postgres", { type: "postgres", passwordMode: "askPassword" }, odd)).field)
      .toBe("connectionString");
  });

  it("stores no password for a connection that asks for it, and no user either when it asks for both", () => {
    expect(normalizeConnectionConfig("postgres", pg("postgres://app:pw@h/shop", { passwordMode: "askPassword", keepPassword: true })))
      .toEqual({ type: "postgres", connectionString: "postgres://app@h/shop", passwordMode: "askPassword" });
    expect(normalizeConnectionConfig("mysql", { type: "mysql", connectionString: "mysql://root:pw@h/shop", passwordMode: "askUser" }))
      .toEqual({ type: "mysql", connectionString: "mysql://h/shop", passwordMode: "askUser" });
    // Switching an existing connection to ask mode drops the password it had.
    const saved: StoredConnectionConfig = { type: "postgres", connectionString: "postgres://app:pw@h/shop" };
    expect(normalizeConnectionConfig("postgres", { type: "postgres", passwordMode: "askPassword" }, saved).connectionString)
      .toBe("postgres://app@h/shop");
  });
});

describe("editableConfig", () => {
  it("rebuilds the URL without its password and says one is saved", () => {
    const edit = editableConfig({ type: "mysql", connectionString: "mysql://root:p%40ss@h:3307/shop?ssl-mode=REQUIRED", isolationLevel: "READ COMMITTED" });
    expect(edit).toEqual({
      type: "mysql", connectionString: "mysql://root@h:3307/shop?ssl-mode=REQUIRED", hasPassword: true, isolationLevel: "READ COMMITTED",
    });
    expect(JSON.stringify(edit)).not.toContain("p%40ss");
    expect(JSON.stringify(edit)).not.toContain("p@ss");
  });

  it("sends no URL at all when it cannot take the password out of it", () => {
    expect(editableConfig({ type: "postgres", connectionString: "postgres://u:secret@h:1:2/db" }))
      .toEqual({ type: "postgres", connectionString: null, hasPassword: false });
  });

  it("passes a SQLite file through", () => {
    expect(editableConfig({ type: "sqlite", path: "/data/app.db" })).toEqual({ type: "sqlite", path: "/data/app.db" });
  });
});

describe("withLogin", () => {
  it("adds the password, keeping the saved user, when only the password is asked for", () => {
    const config: StoredConnectionConfig = { type: "postgres", connectionString: "postgres://app@h/shop", passwordMode: "askPassword" };
    expect(withLogin(config, { user: "intruder", password: "p@ss" }).connectionString).toBe("postgres://app:p%40ss@h/shop");
    expect(savedLoginUser(config)).toBe("app");
  });

  it("adds both when both are asked for", () => {
    const config: StoredConnectionConfig = { type: "mysql", connectionString: "mysql://h/shop", passwordMode: "askUser" };
    expect(withLogin(config, { user: " root ", password: "pw" }).connectionString).toBe("mysql://root:pw@h/shop");
  });
});

describe("filterAllowedDatabases", () => {
  const all = ["shop", "Shop_archive", "crm", "shopify"];

  it("shows everything when nothing is set", () => {
    expect(filterAllowedDatabases(all, {})).toEqual(all);
  });

  it("keeps the listed names and the regex matches, both ignoring case", () => {
    expect(filterAllowedDatabases(all, { allowedDatabases: ["SHOP", "crm"] })).toEqual(["shop", "crm"]);
    expect(filterAllowedDatabases(all, { allowedDatabasesRegex: "^shop" })).toEqual(["shop", "Shop_archive", "shopify"]);
    expect(filterAllowedDatabases(all, { allowedDatabases: ["shop", "crm"], allowedDatabasesRegex: "^s" })).toEqual(["shop"]);
  });

  it("ignores a regex that does not compile rather than hiding everything", () => {
    expect(filterAllowedDatabases(all, { allowedDatabasesRegex: "(" })).toEqual(all);
  });
});
