/**
 * The SSH Tunnel and SSL tabs in the connection tab's model. What is pinned: SSL's two boxes are
 * the URL's own TLS parameter in both ways of entering a server, and survive an engine switch; a
 * problem on either tab is reported in the form's order and opens that tab, and nothing on a tab
 * that is off is checked; only the secret a method uses is sent, and a saved one is kept; a test
 * result goes stale when the tunnel it went through changes, not when a tunnel that is off does;
 * and the result says which way it went and whether it was encrypted.
 */
import { describe, expect, it } from "bun:test";
import {
  connectionConfigOf, emptyForm, fieldOfServerError, formFromSaved, pickEngine, setSslChecks, sslChecks, sslParamOf,
  successDetail, successDetails, switchEntry, tabOfField, tabsFor, targetKey, validate,
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
const tunnel = (extra: Partial<ConnectionFormValues> = {}): ConnectionFormValues =>
  form({ host: "localhost", database: "shop", sshEnabled: true, sshHost: "ssh.example.com", sshUser: "deploy", sshPassword: "sshpw", ...extra });

const success = (extra: Partial<DbTestSuccess> = {}): DbTestSuccess => ({
  ok: true, version: "PostgreSQL 17.2", databases: ["shop"], target: "localhost:5432", elapsedMs: 12, ...extra,
});

describe("the tabs", () => {
  it("are DBGate's four for a server, and General alone for SQLite", () => {
    expect(tabsFor("postgres")).toEqual(["general", "ssh", "ssl", "advanced"]);
    expect(tabsFor("mariadb")).toEqual(["general", "ssh", "ssl", "advanced"]);
    expect(tabsFor("sqlite")).toEqual(["general"]);
  });

  it("each hold their own fields", () => {
    for (const f of ["sshEnabled", "sshHost", "sshPort", "sshBastionHost", "sshAuth", "sshUser", "sshPassword", "sshKeyFile", "sshPassphrase"] as const) {
      expect(tabOfField(f)).toBe("ssh");
    }
    for (const f of ["sslCa", "sslCert", "sslKey", "sslKeyPassword"] as const) expect(tabOfField(f)).toBe("ssl");
    expect(tabOfField("host")).toBe("general");
    expect(tabOfField("isolationLevel")).toBe("advanced");
  });
});

describe("SSL's two boxes are the URL's TLS parameter", () => {
  it("write it into the fields' URL, in each engine's spelling", () => {
    const base = form({ host: "db1", database: "shop" });
    expect(sslChecks(base, NEW)).toEqual({ useSsl: false, rejectUnauthorized: false });

    const on = setSslChecks(base, NEW, true, false);
    expect(sslChecks(on, NEW)).toEqual({ useSsl: true, rejectUnauthorized: false });
    expect(connectionConfigOf(on, NEW).connectionString).toBe("postgres://postgres@db1/shop?sslmode=require");
    expect(connectionConfigOf(setSslChecks(on, NEW, true, true), NEW).connectionString).toBe("postgres://postgres@db1/shop?sslmode=verify-full");
    expect(connectionConfigOf(setSslChecks(on, NEW, false, true), NEW).connectionString).toBe("postgres://postgres@db1/shop");

    const mysql = form({ type: "mysql", host: "db1" });
    expect(connectionConfigOf(setSslChecks(mysql, NEW, true, true), NEW).connectionString).toBe("mysql://root@db1/?ssl-mode=VERIFY_IDENTITY");
  });

  it("leave a URL's own spelling alone while they say the same, and keep its other parameters", () => {
    const fields = switchEntry(form({ entry: "url", url: "postgresql://app@h/shop?sslmode=verify-ca&application_name=ppm" }), NEW, "fields");
    if ("problem" in fields) throw new Error(fields.problem.message);
    expect(sslChecks(fields.values, NEW)).toEqual({ useSsl: true, rejectUnauthorized: true });
    expect(setSslChecks(fields.values, NEW, true, true)).toBe(fields.values);
    const loosened = setSslChecks(fields.values, NEW, true, false);
    expect(connectionConfigOf(loosened, NEW).connectionString).toBe("postgresql://app@h/shop?sslmode=require&application_name=ppm");
  });

  it("rewrite the URL box in URL mode, and are not there to tick without a URL PPM can read", () => {
    const url = form({ entry: "url", url: "postgres://app@h/shop?application_name=ppm" });
    expect(sslChecks(url, NEW)).toEqual({ useSsl: false, rejectUnauthorized: false });
    expect(setSslChecks(url, NEW, true, true).url).toBe("postgres://app@h/shop?sslmode=verify-full&application_name=ppm");
    expect(sslParamOf(setSslChecks(url, NEW, true, true), NEW)).toBe("sslmode=verify-full");

    for (const text of ["", "postgres://h:1:2/db", "mysql://root@h/db"]) {
      const values = form({ entry: "url", url: text });
      expect(sslChecks(values, NEW)).toBeNull();
      expect(setSslChecks(values, NEW, true, true)).toBe(values);
      expect(sslParamOf(values, NEW)).toBeNull();
    }
  });

  it("read prefer as off: it falls back to plain text, which is not what Use SSL promises", () => {
    expect(sslChecks(form({ entry: "url", url: "postgres://h/db?sslmode=prefer" }), NEW)).toEqual({ useSsl: false, rejectUnauthorized: false });
  });

  it("stay ticked across an engine picked by hand", () => {
    const pg = setSslChecks(form({ host: "db1" }), NEW, true, true);
    const mysql = pickEngine(pg, "mysql");
    expect(sslChecks(mysql, NEW)).toEqual({ useSsl: true, rejectUnauthorized: true });
    expect(connectionConfigOf(mysql, NEW).connectionString).toBe("mysql://root@db1/?ssl-mode=VERIFY_IDENTITY");
    expect(sslChecks(pickEngine(form({ host: "db1" }), "mysql"), NEW)).toEqual({ useSsl: false, rejectUnauthorized: false });
  });
});

describe("problems on the two tabs", () => {
  it("are pointed at in the tunnel's order, with the server's words", () => {
    const cases: [Partial<ConnectionFormValues>, string, string][] = [
      [{ sshHost: " " }, "sshHost", "Enter the SSH host."],
      [{ sshHost: "deploy@ssh.example.com" }, "sshHost", "Enter the SSH host's name or address, like ssh.example.com. The login goes in its own field."],
      [{ sshPort: "22a" }, "sshPort", "A number from 1 to 65535."],
      [{ sshBastionHost: "ssh://jump" }, "sshBastionHost", "Write the bastion as host or user@host:port, without ssh://."],
      [{ sshAuth: "keyFile" }, "sshKeyFile", "Pick the private key file."],
      [{ sshAuth: "keyFile", sshKeyFile: "id_ed25519" }, "sshKeyFile", "Give the key file as a full path on the PPM host, not id_ed25519."],
    ];
    for (const [extra, field, message] of cases) {
      const problem = validate(tunnel(extra), NEW, false);
      expect({ extra, problem }).toEqual({ extra, problem: { field, message } });
      expect(tabOfField(problem!.field)).toBe("ssh");
    }
  });

  it("take a full path on either system the PPM host may run", () => {
    for (const key of ["/home/deploy/.ssh/id_ed25519", "~/.ssh/id_ed25519", "~\\.ssh\\id", "C:\\Users\\deploy\\.ssh\\id_ed25519", "D:/keys/id", "\\\\files\\keys\\id"]) {
      expect(validate(tunnel({ sshAuth: "keyFile", sshKeyFile: key }), NEW, false)).toBeNull();
    }
  });

  it("refuse a socket through the tunnel, where the socket is set", () => {
    expect(validate(tunnel({ connMode: "socket", socket: "/run/postgresql" }), NEW, false)?.field).toBe("socket");
    const url = tunnel({ entry: "url", url: "postgres://app@/shop?host=/var/run/postgresql" });
    expect(validate(url, NEW, false)).toMatchObject({ field: "url", message: expect.stringContaining("An SSH tunnel reaches the database by host and port.") });
    expect(validate({ ...url, sshEnabled: false }, NEW, false)).toBeNull();
  });

  it("check nothing on a tab that is off: its fields cannot be edited then", () => {
    expect(validate(tunnel({ sshEnabled: false, sshHost: "", sshPort: "x", sshAuth: "keyFile", sshKeyFile: "id" }), NEW, false)).toBeNull();
    expect(validate(form({ sslCa: "ca.pem", sslKey: "client.key" }), NEW, false)).toBeNull();
  });

  it("check a certificate path with SSL on", () => {
    const on = setSslChecks(form(), NEW, true, false);
    expect(validate({ ...on, sslCa: "ca.pem" }, NEW, false)).toEqual({ field: "sslCa", message: "Give the CA certificate as a full path on the PPM host, not ca.pem." });
    expect(validate({ ...on, sslCert: "c.crt" }, NEW, false)).toEqual({ field: "sslCert", message: "Give the certificate as a full path on the PPM host, not c.crt." });
    expect(validate({ ...on, sslKey: "c.key" }, NEW, false)).toEqual({ field: "sslKey", message: "Give the key file as a full path on the PPM host, not c.key." });
    expect(tabOfField("sslKey")).toBe("ssl");
    expect(validate({ ...on, sslCa: "/etc/ssl/ca.pem", sslKey: "~/certs/c.key" }, NEW, false)).toBeNull();
  });

  it("come after General's and before Advanced's", () => {
    expect(validate(tunnel({ port: "x", sshHost: "" }), NEW, false)?.field).toBe("port");
    const both = setSslChecks(tunnel({ sshHost: "", allowedDatabasesRegex: "[" }), NEW, true, false);
    expect(validate({ ...both, sslCa: "ca.pem" }, NEW, false)?.field).toBe("sshHost");
    expect(validate({ ...both, sshHost: "h", sslCa: "ca.pem" }, NEW, false)?.field).toBe("sslCa");
    expect(validate({ ...both, sshHost: "h" }, NEW, false)?.field).toBe("allowedDatabasesRegex");
  });

  it("from the server open the same fields", () => {
    for (const f of ["sshHost", "sshPort", "sshKeyFile", "sshPassphrase", "sslCa", "sslKeyPassword"]) {
      expect(fieldOfServerError(f, form())).toBe(f as never);
    }
  });
});

describe("what is sent for the two tabs", () => {
  it("is the tunnel with only the secret its method uses, and the files", () => {
    const password = connectionConfigOf(tunnel({ sshPort: " 2222 ", sshBastionHost: " jump ", sshKeyFile: "/k", sshPassphrase: "kp" }), NEW);
    expect(password.ssh).toEqual({
      enabled: true, host: "ssh.example.com", port: "2222", bastionHost: "jump", auth: "password", user: "deploy", keyFile: "/k", password: "sshpw",
    });
    const key = connectionConfigOf(tunnel({ sshAuth: "keyFile", sshKeyFile: "/k", sshPassphrase: "kp" }), NEW);
    expect(key.ssh).toMatchObject({ auth: "keyFile", keyFile: "/k", passphrase: "kp" });
    expect(key.ssh).not.toHaveProperty("password");
    expect(connectionConfigOf(tunnel({ sshAuth: "agent" }), NEW).ssh).not.toHaveProperty("password");

    expect(connectionConfigOf(form({ sslCa: " /ca ", sslKey: "/k", sslKeyPassword: " kp " }), NEW).ssl).toEqual({ ca: "/ca", cert: "", key: "/k", keyPassword: " kp " });
    expect(connectionConfigOf(form(), NEW).ssl).toEqual({ ca: "", cert: "", key: "" });
  });

  it("is always there for a server, so emptying a tab clears it, and never for SQLite", () => {
    expect(connectionConfigOf(form(), NEW).ssh).toEqual({ enabled: false, host: "", port: "", bastionHost: "", auth: "password", user: "", keyFile: "" });
    const sqlite = connectionConfigOf(form({ type: "sqlite", path: "/a.db", sshEnabled: true, sshHost: "h" }), NEW);
    expect(sqlite).toEqual({ type: "sqlite", path: "/a.db" });
  });

  it("asks the server to keep whichever secret is saved", () => {
    for (const flag of ["passwordSaved", "sshPasswordSaved", "sshPassphraseSaved", "sslKeyPasswordSaved"] as const) {
      expect(connectionConfigOf(tunnel({ sshPassword: "" }), editing({ [flag]: true })).keepPassword).toBe(true);
    }
    expect(connectionConfigOf(tunnel(), editing()).keepPassword).toBeUndefined();
  });
});

describe("a saved connection's two tabs", () => {
  const conn = { type: "postgres" as const, name: "prod", group_name: null, color: null, readonly: 1, ai_access: 1 };
  const config = (extra: Partial<Extract<EditableConnectionConfig, { type: "postgres" }>>): EditableConnectionConfig => ({
    type: "postgres", connectionString: "postgres://app@localhost/shop?sslmode=verify-full", hasPassword: false, ...extra,
  });

  it("come back as they were saved, secrets aside", () => {
    const loaded = formFromSaved(conn, config({
      ssh: { enabled: true, host: "ssh.example.com", port: 2222, bastionHost: "jump", auth: "keyFile", user: "deploy", keyFile: "~/.ssh/id", hasPassword: false, hasPassphrase: true },
      ssl: { ca: "/ca.pem", key: "/c.key", hasKeyPassword: true },
    }));
    expect(loaded.values).toMatchObject({
      sshEnabled: true, sshHost: "ssh.example.com", sshPort: "2222", sshBastionHost: "jump", sshAuth: "keyFile", sshUser: "deploy",
      sshKeyFile: "~/.ssh/id", sshPassword: "", sshPassphrase: "", sslCa: "/ca.pem", sslCert: "", sslKey: "/c.key", sslKeyPassword: "",
    });
    expect(loaded).toMatchObject({ sshPasswordSaved: false, sshPassphraseSaved: true, sslKeyPasswordSaved: true });
    expect(sslChecks(loaded.values, editing())).toEqual({ useSsl: true, rejectUnauthorized: true });
  });

  it("are empty and off for one saved before they existed, with the default port left empty", () => {
    const loaded = formFromSaved(conn, config({}));
    expect(loaded.values).toMatchObject({ sshEnabled: false, sshHost: "", sshPort: "", sshAuth: "password", sslCa: "" });
    expect(loaded).toMatchObject({ sshPasswordSaved: false, sshPassphraseSaved: false, sslKeyPasswordSaved: false });
  });

  it("say what is saved even for a URL PPM cannot read", () => {
    const loaded = formFromSaved(conn, config({ connectionString: null, ssh: { enabled: false, host: "h", auth: "password", user: "", hasPassword: true, hasPassphrase: false } }));
    expect(loaded).toMatchObject({ savedUrlUnreadable: true, sshPasswordSaved: true });
  });
});

describe("when a test result stops describing the tunnel", () => {
  const base = tunnel();
  const key = targetKey(base, NEW);

  it("goes stale when the tunnel it went through changes", () => {
    for (const extra of [
      { sshHost: "other" }, { sshPort: "2222" }, { sshBastionHost: "jump" }, { sshUser: "root" }, { sshPassword: "other" },
      { sshAuth: "agent" as const }, { sshEnabled: false },
    ]) {
      expect(targetKey({ ...base, ...extra }, NEW)).not.toBe(key);
    }
    const withKey = tunnel({ sshAuth: "keyFile", sshKeyFile: "/a" });
    expect(targetKey({ ...withKey, sshKeyFile: "/b" }, NEW)).not.toBe(targetKey(withKey, NEW));
    expect(targetKey({ ...withKey, sshPassphrase: "x" }, NEW)).not.toBe(targetKey(withKey, NEW));
    // The ▾ list goes through the tunnel too.
    expect(targetKey({ ...base, sshHost: "other" }, NEW, false)).not.toBe(targetKey(base, NEW, false));
  });

  it("stays when a tab that is off changes, or a secret another method would use", () => {
    const off = form({ host: "db1" });
    expect(targetKey({ ...off, sshHost: "h", sshPassword: "x" }, NEW)).toBe(targetKey(off, NEW));
    expect(targetKey({ ...off, sslCa: "/ca" }, NEW)).toBe(targetKey(off, NEW));
    expect(targetKey({ ...base, sshPassphrase: "unused" }, NEW)).toBe(key);
  });

  it("goes stale with the certificate files, but only with SSL on", () => {
    const on = setSslChecks(form(), NEW, true, false);
    expect(targetKey({ ...on, sslCa: "/ca" }, NEW)).not.toBe(targetKey(on, NEW));
    expect(targetKey({ ...on, sslKeyPassword: "kp" }, NEW)).not.toBe(targetKey(on, NEW));
  });
});

describe("the result of a test through a tunnel", () => {
  const hops = [
    { host: "jump.example.com:22", fingerprint: "SHA256:jump", firstSeen: false },
    { host: "ssh.example.com:22", fingerprint: "SHA256:ssh", firstSeen: true },
  ];

  it("names the way it went", () => {
    expect(successDetail(success({ ssh: [hops[1]!] }), tunnel(), NEW)).toBe("database “shop” · localhost:5432 through SSH ssh.example.com:22 · 12 ms");
    expect(successDetail(success({ ssh: hops }), tunnel(), NEW)).toBe("database “shop” · localhost:5432 through SSH ssh.example.com:22 via jump.example.com:22 · 12 ms");
    expect(successDetail(success(), form({ database: "shop" }), NEW)).toBe("database “shop” · localhost:5432 · 12 ms");
  });

  it("shows each host key in Details, saying which one PPM has just started trusting", () => {
    expect(successDetails(success({ ssh: hops, tls: null }), tunnel(), NEW).split("\n")).toEqual([
      "Bastion jump.example.com:22, host key SHA256:jump",
      "SSH server ssh.example.com:22, host key SHA256:ssh (first connection: PPM trusts this key from now on)",
      "SSL: off · not set in the URL",
    ]);
  });

  it("says whether the connection was encrypted as the server saw it, beside what the URL asked for", () => {
    const on = setSslChecks(form({ sslCa: "/etc/ssl/ca.pem", sslKey: "~/c.key" }), NEW, true, true);
    expect(successDetails(success({ tls: "TLSv1.3" }), on, NEW).split("\n")).toEqual([
      "SSL: on (TLSv1.3) · sslmode=verify-full",
      "Certificate files: CA certificate /etc/ssl/ca.pem, key file ~/c.key",
    ]);
    // prefer fell back to plain text: the box says off, and so does the server.
    const prefer = form({ entry: "url", url: "postgres://h/db?sslmode=prefer" });
    expect(successDetails(success({ tls: null }), prefer, NEW)).toBe("SSL: off · sslmode=prefer");
    expect(successDetails(success({ tls: "TLSv1.3" }), prefer, NEW)).toBe("SSL: on (TLSv1.3) · sslmode=prefer");
    // A server that would not say: only what the URL asked for.
    expect(successDetails(success(), form(), NEW)).toBe("SSL: not set in the URL");
    // Files are listed only when they were used.
    expect(successDetails(success({ tls: null }), form({ sslCa: "/ca" }), NEW)).toBe("SSL: off · not set in the URL");
  });

  it("has no Details for a SQLite file", () => {
    expect(successDetails(success({ target: "/a.db" }), form({ type: "sqlite", path: "/a.db" }), NEW)).toBe("");
  });
});
