/**
 * `peer_invites` (one row per code this side issued), `peer_relay_mailboxes`, and the periodic
 * clean-up of everything peer-related that has outlived its use.
 */
import { getDb } from "../db.service.ts";
import type { PeerActor, PeerPreset, PeerTransportKind } from "../../shared/peer-connections.ts";
import { b64u, hashSecret, secretMatchesHash } from "./peer-crypto.ts";
import { openStored, sealStored } from "./peer-key-store.ts";

export interface NewPeerInvite {
  inviteId: Uint8Array;
  code: string;
  ephemeralPrivate: Uint8Array;
  commitNonce: Uint8Array;
  commitment: Uint8Array;
  pairSecret: string;
  pairMailboxId: string | null;
  label: string;
  transport: PeerTransportKind;
  preset: PeerPreset;
  expiresAt: number;
  createdBy: PeerActor;
}

export interface PeerInviteRow {
  id: string; code_hash: string; eph_priv_enc: string; nonce_enc: string; commitment: string; pair_secret_hash: string;
  pair_mailbox_id: string | null; label: string; transport: PeerTransportKind; preset: PeerPreset; expires_at: number;
  used_at: number | null; created_by: PeerActor; connection_id: string | null; created_at: number;
}

/** What only the inviter holds, opened once the invite has been claimed by an `accept`. */
export interface ClaimedInvite { row: PeerInviteRow; ephemeralPrivate: Buffer; commitNonce: Buffer }

const label = (id: string, col: string) => `peer_invites.${col}:${id}`;

export function insertPeerInvite(inv: NewPeerInvite, now = Date.now()): PeerInviteRow {
  const id = b64u(inv.inviteId);
  getDb().query(`INSERT INTO peer_invites (id, code_hash, eph_priv_enc, nonce_enc, commitment, pair_secret_hash, pair_mailbox_id,
      label, transport, preset, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, hashSecret(inv.code.trim()), sealStored(inv.ephemeralPrivate, label(id, "eph_priv_enc")), sealStored(inv.commitNonce, label(id, "nonce_enc")),
    b64u(inv.commitment), hashSecret(inv.pairSecret), inv.pairMailboxId, inv.label, inv.transport, inv.preset, inv.expiresAt, inv.createdBy, now,
  );
  return getPeerInvite(id)!;
}

export function getPeerInvite(id: string): PeerInviteRow | null {
  return getDb().query("SELECT * FROM peer_invites WHERE id = ?").get(id) as PeerInviteRow | null;
}

export type ClaimFailure = "unknown" | "expired" | "used" | "bad_secret";

/**
 * Take the invite for the one `accept` it allows: unused, unexpired, and the pair secret matches
 * (constant-time). Compare-and-set on `used_at`, so a second `accept` racing the first loses.
 */
export function claimPeerInvite(id: string, pairSecret: string, now = Date.now()): { ok: true; invite: ClaimedInvite } | { ok: false; reason: ClaimFailure } {
  const row = getPeerInvite(id);
  if (!row) return { ok: false, reason: "unknown" };
  if (!secretMatchesHash(pairSecret, row.pair_secret_hash)) return { ok: false, reason: "bad_secret" };
  if (row.used_at !== null) return { ok: false, reason: "used" };
  if (row.expires_at <= now) return { ok: false, reason: "expired" };
  const res = getDb().query("UPDATE peer_invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?").run(now, id, now);
  if (res.changes !== 1) return { ok: false, reason: "used" };
  return {
    ok: true,
    invite: {
      row: { ...row, used_at: now },
      ephemeralPrivate: openStored(row.eph_priv_enc, label(id, "eph_priv_enc")),
      commitNonce: openStored(row.nonce_enc, label(id, "nonce_enc")),
    },
  };
}

export function linkPeerInviteConnection(id: string, connectionId: string): void {
  getDb().query("UPDATE peer_invites SET connection_id = ? WHERE id = ?").run(connectionId, id);
}

/** Withdraw an invite before anyone used it (the person cancelled). */
export function revokePeerInvite(id: string, now = Date.now()): boolean {
  return getDb().query("UPDATE peer_invites SET used_at = ?, expires_at = MIN(expires_at, ?) WHERE id = ? AND used_at IS NULL").run(now, now, id).changes === 1;
}

/**
 * The ephemeral key and commitment nonce are needed only until both sides hold the keys; after
 * that they are wiped so a later copy of the key file and database cannot recompute the digits.
 */
export function wipePeerInviteSecrets(id: string): void {
  getDb().query("UPDATE peer_invites SET eph_priv_enc = '', nonce_enc = '' WHERE id = ?").run(id);
}

export interface PeerRelayMailboxRow { id: string; relay_url: string; mailbox_id: string; read_key_enc: string; cursor: string | null; created_at: number }

export function upsertRelayMailbox(relayUrl: string, mailboxId: string, readKey: string, now = Date.now()): PeerRelayMailboxRow {
  const db = getDb();
  const existing = db.query("SELECT id FROM peer_relay_mailboxes WHERE relay_url = ?").get(relayUrl) as { id: string } | null;
  const id = existing?.id ?? crypto.randomUUID();
  const sealed = sealStored(readKey, `peer_relay_mailboxes.read_key_enc:${id}`);
  if (existing) db.query("UPDATE peer_relay_mailboxes SET mailbox_id = ?, read_key_enc = ?, cursor = NULL WHERE id = ?").run(mailboxId, sealed, id);
  else db.query("INSERT INTO peer_relay_mailboxes (id, relay_url, mailbox_id, read_key_enc, created_at) VALUES (?, ?, ?, ?, ?)").run(id, relayUrl, mailboxId, sealed, now);
  return db.query("SELECT * FROM peer_relay_mailboxes WHERE id = ?").get(id) as PeerRelayMailboxRow;
}

export function getRelayMailbox(relayUrl: string): PeerRelayMailboxRow | null {
  return getDb().query("SELECT * FROM peer_relay_mailboxes WHERE relay_url = ?").get(relayUrl) as PeerRelayMailboxRow | null;
}

export const relayMailboxReadKey = (row: PeerRelayMailboxRow): string =>
  openStored(row.read_key_enc, `peer_relay_mailboxes.read_key_enc:${row.id}`).toString("utf8");

export function setRelayCursor(id: string, cursor: string): void {
  getDb().query("UPDATE peer_relay_mailboxes SET cursor = ? WHERE id = ?").run(cursor, id);
}

export const PENDING_CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;
export const MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface PeerPruneResult {
  /** Connections that never got both confirmations; the transport should revoke their capabilities. */
  removedPending: Array<{ id: string; transport: PeerTransportKind; relay_mailbox_id: string | null; my_send_cap_hash: string | null }>;
  removedInvites: number;
  removedMessages: number;
}

/**
 * Drop what has outlived its use: connections left at `pending_confirm` for a day, invites past
 * expiry (with their sealed secrets), and finished messages older than 30 days. Messages still
 * waiting to go out or to reach the chat are never dropped here.
 */
export function prunePeerState(now = Date.now()): PeerPruneResult {
  const db = getDb();
  return db.transaction(() => {
    const removedPending = db.query(`SELECT id, transport, relay_mailbox_id, my_send_cap_hash FROM peer_connections
      WHERE status = 'pending_confirm' AND created_at <= ?`).all(now - PENDING_CONFIRM_TTL_MS) as PeerPruneResult["removedPending"];
    for (const c of removedPending) db.query("DELETE FROM peer_connections WHERE id = ?").run(c.id);
    const removedInvites = db.query("DELETE FROM peer_invites WHERE expires_at <= ?").run(now - PENDING_CONFIRM_TTL_MS).changes;
    const removedMessages = db.query(`DELETE FROM peer_messages WHERE created_at <= ?
      AND status IN ('delivered','failed','dropped','delivered_to_chat')`).run(now - MESSAGE_RETENTION_MS).changes;
    return { removedPending, removedInvites, removedMessages };
  })();
}
