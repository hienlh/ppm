/**
 * Tables for connections between two PPMs (migration 83). Every column the pairing, chat, relay and
 * Tailscale work needs is here from the start, so no later migration is needed while that work
 * proceeds in parallel. Which part uses which column is listed at the top of `peer-connections-db.ts`.
 *
 * Every statement is `IF NOT EXISTS`, so the step is safe to run again and to renumber. One
 * statement per `exec`: bun:sqlite raises only the last statement's error from a multi-statement
 * `exec`, which would let the version be bumped over a schema that lacks a table.
 *
 * No secret is stored in the clear: `*_enc` columns are sealed by `peer-key-store.ts` under a key
 * kept outside the database, and capabilities this side issues are stored only as hashes.
 */
import type { Database } from "bun:sqlite";

const OUT_STATES = "'queued','awaiting_approval','in_flight','delivered','failed','dropped'";
const IN_STATES = "'received','held_quiet','held_limit','delivering','delivered_to_chat','dropped'";

const STATEMENTS: readonly string[] = [
  // One mailbox per relay for this PPM, shared by every connection that goes through that relay.
  `CREATE TABLE IF NOT EXISTS peer_relay_mailboxes (
    id TEXT PRIMARY KEY,
    relay_url TEXT NOT NULL UNIQUE,
    mailbox_id TEXT NOT NULL,
    read_key_enc TEXT NOT NULL,
    cursor TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS peer_connections (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    peer_claimed_name TEXT NOT NULL DEFAULT '',
    peer_fingerprint TEXT NOT NULL,
    peer_identity_pub TEXT NOT NULL,
    my_role TEXT NOT NULL CHECK (my_role IN ('inviter','acceptor')),
    status TEXT NOT NULL DEFAULT 'pending_confirm' CHECK (status IN ('pending_confirm','active','paused','closed')),
    my_confirmed_at INTEGER,
    peer_confirmed_at INTEGER,
    invite_accepted_by TEXT CHECK (invite_accepted_by IN ('user','assistant')),
    root_key_enc TEXT NOT NULL,
    conn_tag TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL CHECK (transport IN ('relay','tailscale')),
    relay_mailbox_id TEXT REFERENCES peer_relay_mailboxes(id),
    peer_mailbox_id TEXT,
    peer_send_cap_enc TEXT,
    my_send_cap_hash TEXT,
    tailscale_host TEXT,
    inbound_token_hash TEXT,
    outbound_token_enc TEXT,
    session_id TEXT UNIQUE,
    provider_id TEXT NOT NULL DEFAULT 'claude',
    project_key TEXT,
    preset TEXT NOT NULL CHECK (preset IN ('mine','other')),
    scope TEXT NOT NULL DEFAULT 'project' CHECK (scope IN ('project','machine')),
    permission TEXT NOT NULL CHECK (permission IN ('read','ask','auto')),
    outgoing TEXT NOT NULL CHECK (outgoing IN ('ask','filtered','free')),
    allow_child_sessions INTEGER NOT NULL DEFAULT 0,
    daily_msg_limit INTEGER NOT NULL,
    daily_token_limit INTEGER NOT NULL,
    max_auto_exchanges INTEGER NOT NULL,
    auto_exchanges INTEGER NOT NULL DEFAULT 0,
    quiet_start INTEGER,
    quiet_end INTEGER,
    model TEXT,
    account_id TEXT,
    instructions TEXT NOT NULL DEFAULT '',
    send_seq INTEGER NOT NULL DEFAULT 0,
    recv_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    CHECK (scope = 'project' OR preset = 'mine')
  )`,
  `CREATE INDEX IF NOT EXISTS idx_peer_connections_status ON peer_connections(status)`,
  // `id` is the invite id from the code (base64url). The code itself is never stored, only its hash.
  `CREATE TABLE IF NOT EXISTS peer_invites (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    eph_priv_enc TEXT NOT NULL,
    nonce_enc TEXT NOT NULL,
    commitment TEXT NOT NULL,
    pair_secret_hash TEXT NOT NULL,
    pair_mailbox_id TEXT,
    label TEXT NOT NULL DEFAULT '',
    transport TEXT NOT NULL CHECK (transport IN ('relay','tailscale')),
    preset TEXT NOT NULL CHECK (preset IN ('mine','other')),
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_by TEXT NOT NULL CHECK (created_by IN ('user','assistant')),
    connection_id TEXT REFERENCES peer_connections(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_peer_invites_expires ON peer_invites(expires_at)`,
  // Ordered envelopes in both directions. `seq` stays null until an outgoing message is sealed.
  // The id is part of the label each sealed column is bound to, so it is known before the insert.
  `CREATE TABLE IF NOT EXISTS peer_messages (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES peer_connections(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    seq INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('msg','confirm','grant','close')),
    status TEXT NOT NULL,
    envelope_enc TEXT,
    body_enc TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    approval_id TEXT,
    wait_id TEXT,
    reply_to INTEGER,
    expects_reply INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    UNIQUE (connection_id, direction, seq),
    CHECK ((direction = 'out' AND status IN (${OUT_STATES})) OR (direction = 'in' AND status IN (${IN_STATES}))),
    CHECK (direction = 'out' OR seq IS NOT NULL)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_peer_messages_queue ON peer_messages(connection_id, direction, status)`,
  `CREATE INDEX IF NOT EXISTS idx_peer_messages_retry ON peer_messages(status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_peer_messages_created ON peer_messages(created_at)`,
  `CREATE TABLE IF NOT EXISTS peer_usage (
    connection_id TEXT NOT NULL REFERENCES peer_connections(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    msgs_in INTEGER NOT NULL DEFAULT 0,
    msgs_out INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    child_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (connection_id, day)
  )`,
];

export const PEER_TABLES = ["peer_relay_mailboxes", "peer_connections", "peer_invites", "peer_messages", "peer_usage"] as const;

export function applyPeerConnectionsSchema(database: Database): void {
  for (const sql of STATEMENTS) database.exec(sql);
}
