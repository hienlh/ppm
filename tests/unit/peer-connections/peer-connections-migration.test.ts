/**
 * Migration 83: the peer-connection tables. A database at 82 is made by running the ladder and
 * dropping what 83 added, so the step is tested against the real earlier schema.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applyDbPragmas, CURRENT_SCHEMA_VERSION, runMigrations } from "../../../src/services/db.service.ts";
import { applyPeerConnectionsSchema, PEER_TABLES } from "../../../src/services/peer-connections/peer-connections-schema.ts";

const tables = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
const columns = (db: Database, t: string) => (db.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);

function fresh(): Database {
  const db = new Database(":memory:");
  applyDbPragmas(db);
  runMigrations(db);
  return db;
}

function connectionRow(db: Database, id: string, over: Record<string, string | number> = {}) {
  const cols: Record<string, string | number> = {
    id, label: "L", peer_fingerprint: "00".repeat(8), peer_identity_pub: "k", my_role: "inviter", root_key_enc: "x", conn_tag: `tag-${id}`,
    transport: "relay", preset: "mine", permission: "auto", outgoing: "free", daily_msg_limit: 1, daily_token_limit: 1,
    max_auto_exchanges: 1, created_at: 1, updated_at: 1, ...over,
  };
  db.query(`INSERT INTO peer_connections (${Object.keys(cols).join(",")}) VALUES (${Object.keys(cols).map(() => "?").join(",")})`).run(...Object.values(cols));
}

describe("migration 83: peer connections", () => {
  it("brings a fresh database to the current version with every peer table", () => {
    const db = fresh();
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(83);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    for (const t of PEER_TABLES) expect(tables(db)).toContain(t);
    expect(columns(db, "peer_connections")).toEqual(expect.arrayContaining([
      "scope", "relay_mailbox_id", "peer_send_cap_enc", "my_send_cap_hash", "tailscale_host", "inbound_token_hash",
      "outbound_token_enc", "session_id", "send_seq", "recv_seq", "auto_exchanges", "invite_accepted_by",
    ]));
    expect(columns(db, "peer_invites")).toEqual(expect.arrayContaining(["commitment", "nonce_enc", "pair_secret_hash", "pair_mailbox_id"]));
    expect(columns(db, "peer_messages")).toEqual(expect.arrayContaining(["envelope_enc", "body_enc", "attempts", "next_attempt_at", "wait_id", "expects_reply"]));
  });

  it("upgrades a database at 82 and is safe to run again", () => {
    const db = fresh();
    for (const t of [...PEER_TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.exec("PRAGMA user_version = 82");
    runMigrations(db);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    for (const t of PEER_TABLES) expect(tables(db)).toContain(t);
    applyPeerConnectionsSchema(db);
    applyPeerConnectionsSchema(db);
  });

  it("refuses rows that break the constraints", () => {
    const db = fresh();
    connectionRow(db, "a");
    expect(() => connectionRow(db, "b", { conn_tag: "tag-a" })).toThrow();
    expect(() => connectionRow(db, "c", { preset: "other", scope: "machine", permission: "read", outgoing: "ask" })).toThrow();
    connectionRow(db, "d", { scope: "machine" });
    expect(() => connectionRow(db, "e", { status: "open" })).toThrow();
    const msg = (id: string, dir: string, seq: number | null, status: string) =>
      db.query("INSERT INTO peer_messages (id, connection_id, direction, seq, kind, status, created_at) VALUES (?, 'a', ?, ?, 'msg', ?, 1)").run(id, dir, seq, status);
    msg("m1", "out", 1, "in_flight");
    expect(() => msg("m2", "out", 1, "in_flight")).toThrow();
    msg("m3", "out", null, "queued");
    msg("m4", "out", null, "queued");
    expect(() => msg("m5", "in", 1, "queued")).toThrow();
    expect(() => msg("m6", "in", null, "received")).toThrow();
    msg("m7", "in", 1, "received");
    db.query("DELETE FROM peer_connections WHERE id = 'a'").run();
    expect(db.query("SELECT COUNT(*) AS n FROM peer_messages").get()).toEqual({ n: 0 });
  });
});
