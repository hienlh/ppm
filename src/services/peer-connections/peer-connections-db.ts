/**
 * Reading and writing `peer_connections` and `peer_usage`. Invites and relay mailboxes are in
 * `peer-invites-db.ts`, the message queues in `peer-outbox-db.ts` and `peer-inbox-db.ts`. Only this
 * group of files writes these tables; other code reads through them. A column one of the later
 * parts needs and does not find here should be added here, not in a migration of its own.
 *
 * Which part uses which column of `peer_connections`:
 * | Columns                                                         | Used by                         |
 * |-----------------------------------------------------------------|---------------------------------|
 * | id, label, peer_claimed_name, peer_fingerprint, peer_identity_pub, my_role, root_key_enc, conn_tag | all (pairing writes them) |
 * | status, my_confirmed_at, peer_confirmed_at, invite_accepted_by  | pairing and confirmation        |
 * | session_id, provider_id, project_key                            | connection chat                 |
 * | preset … instructions, auto_exchanges                           | settings, limits, outgoing card |
 * | send_seq, recv_seq                                              | outbox / inbox (this layer)     |
 * | relay_mailbox_id, peer_mailbox_id, peer_send_cap_enc, my_send_cap_hash | relay transport          |
 * | tailscale_host, inbound_token_hash, outbound_token_enc          | Tailscale transport             |
 *
 * `session_id` is always looked up through `resolveMigratedSession`.
 */
import { getDb, resolveMigratedSession } from "../db.service.ts";
import {
  resolvePeerSettings, type PeerActor, type PeerConnectionSettings, type PeerConnectionStatus, type PeerRole, type PeerTransportKind,
} from "../../shared/peer-connections.ts";
import { b64u, fromB64u } from "./peer-crypto.ts";
import { directionalKeys } from "./peer-pairing-keys.ts";
import { openStored, sealStored } from "./peer-key-store.ts";

export interface PeerConnectionRow {
  id: string; label: string; peer_claimed_name: string; peer_fingerprint: string; peer_identity_pub: string;
  my_role: PeerRole; status: PeerConnectionStatus; my_confirmed_at: number | null; peer_confirmed_at: number | null;
  invite_accepted_by: PeerActor | null; root_key_enc: string; conn_tag: string; transport: PeerTransportKind;
  relay_mailbox_id: string | null; peer_mailbox_id: string | null; peer_send_cap_enc: string | null; my_send_cap_hash: string | null;
  tailscale_host: string | null; inbound_token_hash: string | null; outbound_token_enc: string | null;
  session_id: string | null; provider_id: string; project_key: string | null;
  preset: PeerConnectionSettings["preset"]; scope: PeerConnectionSettings["scope"]; permission: PeerConnectionSettings["permission"];
  outgoing: PeerConnectionSettings["outgoing"]; allow_child_sessions: number; daily_msg_limit: number; daily_token_limit: number;
  max_auto_exchanges: number; auto_exchanges: number; quiet_start: number | null; quiet_end: number | null;
  model: string | null; account_id: string | null; instructions: string;
  send_seq: number; recv_seq: number; created_at: number; updated_at: number; closed_at: number | null;
}

export interface NewPeerConnection {
  label: string;
  peerClaimedName: string;
  peerFingerprint: string;
  peerIdentityPublic: Uint8Array;
  myRole: PeerRole;
  root: Uint8Array;
  transport: PeerTransportKind;
  inviteAcceptedBy: PeerActor | null;
  settings: PeerConnectionSettings;
  tailscaleHost?: string | null;
  relayMailboxId?: string | null;
  peerMailboxId?: string | null;
}

const rootLabel = (id: string) => `peer_connections.root_key_enc:${id}`;
const SECRET_COLUMNS = ["peer_send_cap_enc", "outbound_token_enc"] as const;
export type PeerSecretColumn = typeof SECRET_COLUMNS[number];
const HASH_COLUMNS = ["my_send_cap_hash", "inbound_token_hash"] as const;
export type PeerHashColumn = typeof HASH_COLUMNS[number];

function settingsColumns(s: PeerConnectionSettings) {
  const r = resolvePeerSettings(s, s.preset);
  return {
    preset: r.preset, scope: r.scope, permission: r.permission, outgoing: r.outgoing, allow_child_sessions: r.allowChildSessions ? 1 : 0,
    daily_msg_limit: r.dailyMsgLimit, daily_token_limit: r.dailyTokenLimit, max_auto_exchanges: r.maxAutoExchanges,
    quiet_start: r.quietStart, quiet_end: r.quietEnd, model: r.model, account_id: r.accountId, instructions: r.instructions,
  };
}

export function insertPeerConnection(input: NewPeerConnection, now = Date.now()): PeerConnectionRow {
  const id = crypto.randomUUID();
  const cols: Record<string, string | number | null> = {
    id, label: input.label, peer_claimed_name: input.peerClaimedName, peer_fingerprint: input.peerFingerprint,
    peer_identity_pub: b64u(input.peerIdentityPublic), my_role: input.myRole, status: "pending_confirm",
    invite_accepted_by: input.inviteAcceptedBy, root_key_enc: sealStored(input.root, rootLabel(id)),
    conn_tag: b64u(directionalKeys(input.root).connTag), transport: input.transport,
    tailscale_host: input.tailscaleHost ?? null, relay_mailbox_id: input.relayMailboxId ?? null, peer_mailbox_id: input.peerMailboxId ?? null,
    ...settingsColumns(input.settings), created_at: now, updated_at: now,
  };
  const names = Object.keys(cols);
  getDb().query(`INSERT INTO peer_connections (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(cols));
  return getPeerConnection(id)!;
}

export function getPeerConnection(id: string): PeerConnectionRow | null {
  return getDb().query("SELECT * FROM peer_connections WHERE id = ?").get(id) as PeerConnectionRow | null;
}

export function getPeerConnectionByTag(connTag: string): PeerConnectionRow | null {
  return getDb().query("SELECT * FROM peer_connections WHERE conn_tag = ?").get(connTag) as PeerConnectionRow | null;
}

export function getPeerConnectionBySession(sessionId: string): PeerConnectionRow | null {
  return getDb().query("SELECT * FROM peer_connections WHERE session_id = ?").get(resolveMigratedSession(sessionId)) as PeerConnectionRow | null;
}

export function listPeerConnections(opts: { includeClosed?: boolean } = {}): PeerConnectionRow[] {
  const where = opts.includeClosed ? "" : "WHERE status != 'closed'";
  return getDb().query(`SELECT * FROM peer_connections ${where} ORDER BY created_at`).all() as PeerConnectionRow[];
}

export interface PeerConnectionKeys { sendKey: Buffer; receiveKey: Buffer; connTag: string }

/** This side's keys: the inviter sends with `k_ab`, the acceptor with `k_ba`. */
export function peerConnectionKeys(row: PeerConnectionRow): PeerConnectionKeys {
  const keys = directionalKeys(openStored(row.root_key_enc, rootLabel(row.id)));
  const inviter = row.my_role === "inviter";
  return { sendKey: inviter ? keys.kAb : keys.kBa, receiveKey: inviter ? keys.kBa : keys.kAb, connTag: b64u(keys.connTag) };
}

export const peerIdentityOf = (row: PeerConnectionRow) => ({ identityPublic: fromB64u(row.peer_identity_pub, 32), fingerprint: row.peer_fingerprint });

const ALLOWED: Record<PeerConnectionStatus, readonly PeerConnectionStatus[]> = {
  pending_confirm: ["active", "closed"],
  active: ["paused", "closed"],
  paused: ["active", "closed"],
  closed: [],
};

/**
 * Move a connection from `from` to `to` only if it is still in `from` (compare and set). False
 * when another writer moved it first or the move is not allowed. `pending_confirm → active` goes
 * through `recordPeerConfirmation`, which also requires both confirmations.
 */
export function transitionPeerConnection(id: string, from: PeerConnectionStatus, to: PeerConnectionStatus, now = Date.now()): boolean {
  if (!ALLOWED[from].includes(to) || (from === "pending_confirm" && to === "active")) return false;
  const res = getDb().query(
    "UPDATE peer_connections SET status = ?, updated_at = ?, closed_at = CASE WHEN ? = 'closed' THEN ? ELSE closed_at END WHERE id = ? AND status = ?",
  ).run(to, now, to, now, id, from);
  return res.changes === 1;
}

/**
 * Record one side's confirmation of the six digits (`mine`: the person here; `peer`: a signed
 * `confirm` from the other side). The connection becomes active once both are recorded.
 */
export function recordPeerConfirmation(id: string, side: "mine" | "peer", now = Date.now()): PeerConnectionStatus | null {
  const db = getDb();
  return db.transaction(() => {
    const column = side === "mine" ? "my_confirmed_at" : "peer_confirmed_at";
    db.query(`UPDATE peer_connections SET ${column} = COALESCE(${column}, ?), updated_at = ? WHERE id = ? AND status = 'pending_confirm'`).run(now, now, id);
    db.query(`UPDATE peer_connections SET status = 'active', updated_at = ?
      WHERE id = ? AND status = 'pending_confirm' AND my_confirmed_at IS NOT NULL AND peer_confirmed_at IS NOT NULL`).run(now, id);
    return (db.query("SELECT status FROM peer_connections WHERE id = ?").get(id) as { status: PeerConnectionStatus } | null)?.status ?? null;
  })();
}

export function updatePeerSettings(id: string, settings: PeerConnectionSettings, now = Date.now()): void {
  const cols = settingsColumns(settings);
  const names = Object.keys(cols);
  getDb().query(`UPDATE peer_connections SET ${names.map((n) => `${n} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...Object.values(cols), now, id);
}

export function settingsOf(row: PeerConnectionRow): PeerConnectionSettings {
  return resolvePeerSettings({
    preset: row.preset, scope: row.scope, permission: row.permission, outgoing: row.outgoing, allowChildSessions: row.allow_child_sessions === 1,
    dailyMsgLimit: row.daily_msg_limit, dailyTokenLimit: row.daily_token_limit, maxAutoExchanges: row.max_auto_exchanges,
    quietStart: row.quiet_start, quietEnd: row.quiet_end, model: row.model, accountId: row.account_id, instructions: row.instructions,
  }, row.preset);
}

export function attachPeerSession(id: string, sessionId: string, providerId: string, projectKey: string | null, now = Date.now()): void {
  getDb().query("UPDATE peer_connections SET session_id = ?, provider_id = ?, project_key = ?, updated_at = ? WHERE id = ?")
    .run(sessionId, providerId, projectKey, now, id);
}

/** A capability received from the other side, sealed at rest. */
export function storePeerSecret(id: string, column: PeerSecretColumn, value: string, extra: { peerMailboxId?: string } = {}): void {
  if (!SECRET_COLUMNS.includes(column)) throw new Error("not a secret column");
  const sealed = sealStored(value, `peer_connections.${column}:${id}`);
  const mailbox = extra.peerMailboxId !== undefined ? ", peer_mailbox_id = ?" : "";
  const args = extra.peerMailboxId !== undefined ? [sealed, extra.peerMailboxId] : [sealed];
  getDb().query(`UPDATE peer_connections SET ${column} = ?${mailbox}, updated_at = ? WHERE id = ?`).run(...args, Date.now(), id);
}

export function readPeerSecret(row: PeerConnectionRow, column: PeerSecretColumn): string | null {
  if (!SECRET_COLUMNS.includes(column)) throw new Error("not a secret column");
  const sealed = row[column];
  return sealed ? openStored(sealed, `peer_connections.${column}:${row.id}`).toString("utf8") : null;
}

/** A capability this side issued: only its hash is kept (`hashSecret`), to check and to revoke. */
export function storeIssuedHash(id: string, column: PeerHashColumn, hash: string | null): void {
  if (!HASH_COLUMNS.includes(column)) throw new Error("not a hash column");
  getDb().query(`UPDATE peer_connections SET ${column} = ?, updated_at = ? WHERE id = ?`).run(hash, Date.now(), id);
}

export interface PeerUsageDelta {
  msgsIn?: number; msgsOut?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; childTokens?: number;
}

export function addPeerUsage(connectionId: string, day: string, d: PeerUsageDelta): void {
  getDb().query(`INSERT INTO peer_usage (connection_id, day, msgs_in, msgs_out, input_tokens, output_tokens, cache_read_tokens, child_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (connection_id, day) DO UPDATE SET msgs_in = msgs_in + excluded.msgs_in, msgs_out = msgs_out + excluded.msgs_out,
      input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, child_tokens = child_tokens + excluded.child_tokens`)
    .run(connectionId, day, d.msgsIn ?? 0, d.msgsOut ?? 0, d.inputTokens ?? 0, d.outputTokens ?? 0, d.cacheReadTokens ?? 0, d.childTokens ?? 0);
}

export function getPeerUsage(connectionId: string, day: string) {
  return getDb().query("SELECT * FROM peer_usage WHERE connection_id = ? AND day = ?").get(connectionId, day) as
    | { msgs_in: number; msgs_out: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; child_tokens: number }
    | null;
}
