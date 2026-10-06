/**
 * The connection tab's model: two ways of entering one server, what is sent for each password
 * mode, the order problems are reported in, and when a test result stops describing the form.
 */
import { describe, expect, it } from "bun:test";
import {
  connectionConfigOf, defaultName, effectivePasswordMode, emptyForm, fieldOfServerError, formFromSaved,
  pickEngine, saveRequestBody, successDetail, switchEntry, tabOfField, targetKey, targetOf, testRequestBody,
  typeUrl, urlHelp, validate,
  type ConnectionFormValues, type FormContext,
} from "../../../src/web/components/database/connection-form/connection-form-state";
import type { DbTestSuccess, EditableConnectionConfig } from "../../../src/shared/db-connection-config";

const NEW: FormContext = { editing: null, takenNames: new Set() };
const editing = (extra: Partial<NonNullable<FormContext["editing"]>> = {}): FormContext => ({
  editing: {
    id: 7, passwordSaved: false, savedUrlUnreadable: false, sshPasswordSaved: false, sshPassphraseSaved: false, sslKeyPasswordSaved: false,
    ...extra,
  },
  takenNames: new Set(),
});

const form = (extra: Partial<ConnectionFormValues> = {}): ConnectionFormValues => ({ ...emptyForm("postgres"), ...extra });

/** The fields a URL reads into, or the test fails saying why it did not. */
function fieldsOf(values: ConnectionFormValues, ctx: FormContext = NEW): ConnectionFormValues {
  const next = switchEntry(values, ctx, "fields");
  if ("problem" in next) throw new Error(`stayed on the URL: ${next.problem.message}`);
  return next.values;
}

function urlOf(values: ConnectionFormValues, ctx: FormContext = NEW): string {
  const next = switchEntry(values, ctx, "url");
  if ("problem" in next) throw new Error(next.problem.message);
  return next.values.url;
}

const success = (extra: Partial<DbTestSuccess> = {}): DbTestSuccess => ({
  ok: true, version: "MySQL 8.4.3", databases: ["shop", "shop_test", "billing"], target: "h:3307", elapsedMs: 12, ...extra,
});

describe("a URL and the fields are one connection", () => {
  it("reads a MySQL URL with an escaped password and TLS into the fields, and builds the same URL back", () => {
    const pasted = typeUrl(form({ entry: "url" }), NEW, "mysql://u:p%40x@h:3307/db?ssl-mode=REQUIRED");
    expect(pasted.type).toBe("mysql");

    const fields = fieldsOf(pasted);
    expect(fields).toMatchObject({ connMode: "host", host: "h", port: "3307", user: "u", password: "p@x", database: "db" });
    expect(fields.urlExtras?.ssl).toEqual({ name: "ssl-mode", value: "REQUIRED" });

    expect(urlOf(fields)).toBe("mysql://u:p%40x@h:3307/db?ssl-mode=REQUIRED");
    expect(connectionConfigOf(fields, NEW).connectionString).toBe("mysql://u:p%40x@h:3307/db?ssl-mode=REQUIRED");
  });

  it("reads libpq's socket form into Connection mode Socket", () => {
    const fields = fieldsOf(typeUrl(form({ entry: "url" }), NEW, "postgres://app@/shop?host=/var/run/postgresql"));
    expect(fields).toMatchObject({ connMode: "socket", socket: "/var/run/postgresql", host: "", user: "app", database: "shop" });
    expect(targetOf(fields, NEW)).toBe("socket /var/run/postgresql");
    expect(connectionConfigOf(fields, NEW).connectionString).toBe("postgres://app@/shop?host=/var/run/postgresql");
  });

  it("builds no URL out of fields nobody filled", () => {
    expect(urlOf(form())).toBe("");
  });

  it("fills the placeholders' promise into a built URL: localhost and the engine's user", () => {
    expect(urlOf(form({ database: "shop" }))).toBe("postgres://postgres@localhost/shop");
    expect(urlOf(form({ type: "mysql", port: "3307" }))).toBe("mysql://root@localhost:3307/");
  });

  it("stays on a URL the fields cannot hold, and says why", () => {
    const next = switchEntry(form({ entry: "url", url: "postgres://h:1:2/db" }), NEW, "fields");
    expect("problem" in next && next.problem.field).toBe("url");
  });

  it("moves a new connection's engine to the URL's, but not a saved one's", () => {
    expect(typeUrl(form({ entry: "url" }), NEW, "mariadb://root@h/shop").type).toBe("mariadb");
    expect(typeUrl(form({ type: "mysql", entry: "url" }), editing(), "mariadb://root@h/shop").type).toBe("mysql");
  });

  it("takes a MariaDB URL on a saved MySQL connection and refuses a Postgres one, as the server does", () => {
    const saved = form({ type: "mysql", entry: "url" });
    expect(urlHelp({ ...saved, url: "mariadb://root@h/shop" }, editing(), true).tone).toBe("ok");
    expect(urlHelp({ ...saved, url: "postgres://app@h/shop" }, editing(), true)).toEqual({
      tone: "bad", text: "This connection is MySQL; the URL is for PostgreSQL.",
    });
  });

  it("sends a file path to SQLite rather than reading it as a host", () => {
    expect(urlHelp(form({ entry: "url", url: "/home/me/app.db" }), NEW, true)).toEqual({
      tone: "bad", text: "That is a file path: pick SQLite above to open a file.",
    });
  });

  it("clears a URL for another engine when a tile is picked by hand", () => {
    const typed = typeUrl(form({ entry: "url" }), NEW, "postgres://app@h/shop");
    const picked = pickEngine(typed, "mysql");
    expect(picked).toMatchObject({ type: "mysql", url: "", urlExtras: null });
  });
});

describe("the order problems are pointed at", () => {
  it("names the file first for SQLite", () => {
    expect(validate(form({ type: "sqlite" }), NEW, false)).toEqual({ field: "path", message: "Enter the path of the database file." });
  });

  it("asks for a URL in URL mode", () => {
    expect(validate(form({ entry: "url" }), NEW, false)).toEqual({ field: "url", message: "Enter the database URL." });
  });

  it("asks for a socket path in socket mode, and a real port in host mode", () => {
    expect(validate(form({ connMode: "socket" }), NEW, false)?.field).toBe("socket");
    expect(validate(form({ port: "70000" }), NEW, false)).toEqual({ field: "port", message: "A number from 1 to 65535." });
    expect(validate(form({ port: "5432" }), NEW, false)).toBeNull();
  });

  it("puts a broken regular expression on the Advanced tab, after the connection itself", () => {
    const problem = validate(form({ port: "x", allowedDatabasesRegex: "[" }), NEW, false);
    expect(problem?.field).toBe("port");
    const regex = validate(form({ allowedDatabasesRegex: "[" }), NEW, false);
    expect(regex).toEqual({ field: "allowedDatabasesRegex", message: "Not a valid regular expression." });
    expect(tabOfField(regex!.field)).toBe("advanced");
  });

  it("refuses a taken name only when saving: a Test runs whatever the name is", () => {
    const taken: FormContext = { editing: null, takenNames: new Set(["shop@localhost"]) };
    const values = form({ database: "shop" });
    expect(validate(values, taken, false)).toBeNull();
    expect(validate(values, taken, true)).toEqual({ field: "name", message: "Another connection already has this name." });
    expect(validate({ ...values, name: "shop (2)" }, taken, true)).toBeNull();
  });
});

describe("the name a connection gets when none is typed", () => {
  it("is db@host, then user@host, then the engine's user", () => {
    expect(defaultName(form({ host: "db1", user: "app", database: "shop" }), NEW)).toBe("shop@db1");
    expect(defaultName(form({ host: "db1", user: "app" }), NEW)).toBe("app@db1");
    expect(defaultName(form({ type: "mysql" }), NEW)).toBe("root@localhost");
  });

  it("says localhost for a socket, leaves out a login PPM asks for, and uses a SQLite file's name", () => {
    expect(defaultName(form({ connMode: "socket", host: "ignored", user: "app" }), NEW)).toBe("app@localhost");
    expect(defaultName(form({ host: "db1", user: "app", passwordMode: "askUser" }), NEW)).toBe("postgres@db1");
    expect(defaultName(form({ type: "sqlite", path: "C:\\data\\shop.sqlite" }), NEW)).toBe("shop.sqlite");
    expect(defaultName(form({ type: "sqlite" }), NEW)).toBe("database.db");
  });
});

describe("what is sent", () => {
  it("keeps the password out of a connection that asks for it, and the user too when it asks for both", () => {
    const base = form({ host: "db1", user: "app", password: "secret", database: "shop" });
    expect(connectionConfigOf({ ...base, passwordMode: "askPassword" }, NEW)).toMatchObject({
      passwordMode: "askPassword", connectionString: "postgres://app@db1/shop",
    });
    expect(connectionConfigOf({ ...base, passwordMode: "askUser" }, NEW)).toMatchObject({
      passwordMode: "askUser", connectionString: "postgres://db1/shop",
    });
    expect(connectionConfigOf(base, NEW).connectionString).toBe("postgres://app:secret@db1/shop");
  });

  it("saves a URL's password as typed: URL mode is always Save and encrypt", () => {
    const values = form({ entry: "url", url: "postgres://app:secret@db1/shop", passwordMode: "askPassword" });
    expect(effectivePasswordMode(values)).toBe("save");
    expect(connectionConfigOf(values, NEW)).toMatchObject({ passwordMode: "save", connectionString: "postgres://app:secret@db1/shop" });
  });

  it("asks the server to keep a saved password an empty field leaves alone", () => {
    const values = form({ host: "db1", user: "app" });
    expect(connectionConfigOf(values, editing({ passwordSaved: true })).keepPassword).toBe(true);
    expect(connectionConfigOf(values, editing()).keepPassword).toBeUndefined();
    expect(testRequestBody(values, editing()).connectionId).toBe(7);
    expect(testRequestBody(values, NEW).connectionId).toBeUndefined();
  });

  it("leaves a saved URL PPM cannot read in place until a new one is typed", () => {
    const ctx = editing({ savedUrlUnreadable: true });
    const values = form({ entry: "url" });
    expect(validate(values, ctx, true)).toBeNull();
    expect("connectionString" in connectionConfigOf(values, ctx)).toBe(false);
    expect(connectionConfigOf({ ...values, url: "postgres://app@db2/shop" }, ctx).connectionString).toBe("postgres://app@db2/shop");
  });

  it("sends Use only database only with a database, and the isolation level only when one is picked", () => {
    expect("singleDatabase" in connectionConfigOf(form(), NEW)).toBe(false);
    expect(connectionConfigOf(form({ database: "shop", singleDatabase: false }), NEW).singleDatabase).toBe(false);
    expect("isolationLevel" in connectionConfigOf(form(), NEW)).toBe(false);
    expect(connectionConfigOf(form({ isolationLevel: "SERIALIZABLE" }), NEW).isolationLevel).toBe("SERIALIZABLE");
    expect(connectionConfigOf(form({ allowedDatabases: " shop \n\n billing" }), NEW).allowedDatabases).toEqual(["shop", "billing"]);
  });

  it("sends the query timeout only when one is typed, and refuses one that is not whole seconds", () => {
    expect("queryTimeoutSec" in connectionConfigOf(form({ queryTimeoutSec: "  " }), NEW)).toBe(false);
    expect(connectionConfigOf(form({ queryTimeoutSec: " 30 " }), NEW).queryTimeoutSec).toBe(30);
    for (const typed of ["0", "1.5", "30s", "86401"]) {
      expect(validate(form({ queryTimeoutSec: typed }), NEW, false)).toEqual({ field: "queryTimeoutSec", message: "A whole number of seconds, or empty for no limit." });
    }
    expect(validate(form({ queryTimeoutSec: "86400" }), NEW, false)).toBeNull();
    expect(validate(form({ type: "sqlite", path: "/a.db", queryTimeoutSec: "soon" }), NEW, false)).toBeNull();
    expect(tabOfField("queryTimeoutSec")).toBe("advanced");
    expect(fieldOfServerError("queryTimeoutSec", form())).toBe("queryTimeoutSec");
  });

  it("clears a folder and a color when editing, leaves them out when new, and never lets the AI at an ask connection", () => {
    expect(saveRequestBody(form(), NEW)).toMatchObject({ groupName: undefined, color: undefined, aiAccess: true, name: "postgres@localhost" });
    expect(saveRequestBody(form(), editing())).toMatchObject({ groupName: null, color: null });
    expect(saveRequestBody(form({ folder: " prod ", color: "#ef4444" }), NEW)).toMatchObject({ groupName: "prod", color: "#ef4444" });
    expect(saveRequestBody(form({ passwordMode: "askPassword", aiAccess: true }), NEW).aiAccess).toBe(false);
  });
});

describe("a saved connection in the form", () => {
  const conn = { type: "postgres" as const, name: "prod", group_name: "work", color: null, readonly: 1, ai_access: 0 };
  const config = (extra: Partial<Extract<EditableConnectionConfig, { type: "postgres" }>>): EditableConnectionConfig => ({
    type: "postgres", connectionString: "postgres://app@db1:5433/shop", hasPassword: true, ...extra,
  });

  it("shows a connection saved before the form as its URL, without the password", () => {
    const { values, passwordSaved, savedUrlUnreadable } = formFromSaved(conn, config({}));
    expect(values).toMatchObject({ entry: "url", url: "postgres://app@db1:5433/shop", host: "db1", port: "5433", folder: "work", aiAccess: false, readonly: true });
    expect(values.password).toBe("");
    expect(passwordSaved).toBe(true);
    expect(savedUrlUnreadable).toBe(false);
  });

  it("opens one that asks for its password on the fields, where Password mode is", () => {
    const { values } = formFromSaved(conn, config({ entry: "url", passwordMode: "askPassword" }));
    expect(values).toMatchObject({ entry: "fields", passwordMode: "askPassword", user: "app" });
  });

  it("says so when PPM cannot read the saved URL", () => {
    const { values, savedUrlUnreadable } = formFromSaved(conn, config({ connectionString: null }));
    expect(values).toMatchObject({ entry: "url", url: "" });
    expect(savedUrlUnreadable).toBe(true);
    expect(urlHelp(values, editing({ savedUrlUnreadable: true }), true).text).toContain("It is kept until you enter a new one.");
  });
});

describe("when a test result stops describing the form", () => {
  const base = form({ host: "db1", user: "app", password: "pw", database: "shop" });
  const key = targetKey(base, NEW);

  it("goes stale when anything it connected with changes", () => {
    expect(targetKey({ ...base, host: "db2" }, NEW)).not.toBe(key);
    expect(targetKey({ ...base, port: "5433" }, NEW)).not.toBe(key);
    expect(targetKey({ ...base, password: "other" }, NEW)).not.toBe(key);
    expect(targetKey({ ...base, database: "billing" }, NEW)).not.toBe(key);
    expect(targetKey({ ...base, passwordMode: "askPassword" }, NEW)).not.toBe(key);
  });

  it("stays when only how PPM shows the connection changes", () => {
    expect(targetKey({ ...base, name: "prod", folder: "work", color: "#ef4444", readonly: false, aiAccess: false }, NEW)).toBe(key);
  });

  it("keeps the ▾ list across a database picked from it", () => {
    expect(targetKey({ ...base, database: "billing" }, NEW, false)).toBe(targetKey(base, NEW, false));
  });

  it("does not hold a password PPM will ask for", () => {
    const asks = { ...base, passwordMode: "askPassword" as const };
    expect(targetKey({ ...asks, password: "other" }, NEW)).toBe(targetKey(asks, NEW));
  });
});

describe("the line after Connected", () => {
  it("names the database the connection opens, where it went and how long it took", () => {
    const values = form({ type: "mysql", host: "h", port: "3307", database: "shop" });
    expect(successDetail(success(), values, NEW)).toBe("database “shop” · h:3307 · 12 ms");
  });

  it("counts the databases the Advanced filter lets through when none is picked", () => {
    const values = form({ type: "mysql", host: "h", port: "3307", allowedDatabasesRegex: "^shop" });
    expect(successDetail(success(), values, NEW)).toBe("2 databases · h:3307 · 12 ms");
    expect(successDetail(success({ databases: ["billing"] }), values, NEW)).toBe("0 databases · h:3307 · 12 ms");
  });

  it("is the file and the time for SQLite", () => {
    expect(successDetail(success({ target: "/data/app.db", elapsedMs: 3 }), form({ type: "sqlite", path: "/data/app.db" }), NEW)).toBe("/data/app.db · 3 ms");
  });
});

describe("a refusal from the server", () => {
  it("points at the box the connection string came from", () => {
    expect(fieldOfServerError("connectionString", form({ entry: "url" }))).toBe("url");
    expect(fieldOfServerError("connectionString", form())).toBe("host");
    expect(fieldOfServerError("connectionString", form({ connMode: "socket" }))).toBe("socket");
    expect(fieldOfServerError("isolationLevel", form())).toBe("isolationLevel");
    expect(fieldOfServerError("nonsense", form())).toBeNull();
    expect(fieldOfServerError(undefined, form())).toBeNull();
  });
});
