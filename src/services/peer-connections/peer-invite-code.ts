/**
 * The invite code one PPM hands another (`ppm-peer:v1:<base64url JSON>`) and the `accept` the other
 * side answers with through the pairing door. Both are signed by the sender's identity key. Neither
 * grants the right to send messages: the invite's `pair_secret` opens the pairing door for exactly
 * one `accept`, and the real send capability is exchanged later, encrypted, once both people have
 * confirmed the digits.
 */
import { b64u, ed25519Sign, ed25519Verify, fromB64u, KEY_BYTES } from "./peer-crypto.ts";
import { INVITE_ID_BYTES } from "./peer-pairing-keys.ts";

export const INVITE_PREFIX = "ppm-peer:v1:";
export const INVITE_MAX_CHARS = 4096;
export const INVITE_DEFAULT_TTL_MS = 15 * 60 * 1000;
const LABEL_MAX = 80;
const NAME_MAX = 80;

export type PeerTransportHint =
  | { relay: { url: string; mailbox: string } }
  | { tailscale: { host: string } };

export interface PeerInvite {
  inviteId: Buffer;
  inviterEphemeral: Buffer;
  inviterIdentity: Buffer;
  commitment: Buffer;
  pairSecret: string;
  hint: PeerTransportHint;
  label: string;
  expiresAt: number;
}

export interface PeerAccept {
  inviteId: Buffer;
  acceptorEphemeral: Buffer;
  acceptorIdentity: Buffer;
  pairSecret: string;
  /** What the accepting machine calls itself. Shown with a note; never placed in server-written text. */
  claimedName: string;
  sentAt: number;
}

function canonicalHint(hint: PeerTransportHint): PeerTransportHint {
  if ("relay" in hint) {
    const { url, mailbox } = hint.relay;
    if (typeof url !== "string" || !/^https:\/\/[^\s]{1,500}$/.test(url)) throw new Error("relay hint needs an https URL");
    if (typeof mailbox !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(mailbox)) throw new Error("bad relay mailbox");
    return { relay: { url, mailbox } };
  }
  if ("tailscale" in hint) {
    const { host } = hint.tailscale;
    if (typeof host !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new Error("bad tailscale host");
    return { tailscale: { host } };
  }
  throw new Error("unknown transport hint");
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error("expected text");
  // Control characters (newlines included) are dropped: these strings end up in a UI line.
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

const inviteSigned = (i: PeerInvite): Buffer => Buffer.from("ppm-peer invite v1\n" + JSON.stringify([
  b64u(i.inviteId), b64u(i.inviterEphemeral), b64u(i.inviterIdentity), b64u(i.commitment), i.pairSecret,
  canonicalHint(i.hint), i.label, i.expiresAt,
]), "utf8");

const acceptSigned = (a: PeerAccept): Buffer => Buffer.from("ppm-peer accept v1\n" + JSON.stringify([
  b64u(a.inviteId), b64u(a.acceptorEphemeral), b64u(a.acceptorIdentity), a.pairSecret, a.claimedName, a.sentAt,
]), "utf8");

export function encodeInvite(invite: PeerInvite, identityPrivate: Uint8Array): string {
  const label = cleanText(invite.label, LABEL_MAX);
  const body = { ...invite, label, hint: canonicalHint(invite.hint) };
  const sig = ed25519Sign(identityPrivate, inviteSigned(body));
  const json = JSON.stringify({
    id: b64u(body.inviteId), ie: b64u(body.inviterEphemeral), ii: b64u(body.inviterIdentity), c: b64u(body.commitment),
    ps: body.pairSecret, hint: body.hint, label, exp: body.expiresAt, sig: b64u(sig),
  });
  const code = INVITE_PREFIX + Buffer.from(json, "utf8").toString("base64url");
  if (code.length > INVITE_MAX_CHARS) throw new Error("invite code too long");
  return code;
}

/**
 * Parse an invite and check its signature and expiry. Whitespace around the code (a paste) is
 * ignored. Throws with a short reason on anything wrong.
 */
export function decodeInvite(code: string, now = Date.now()): PeerInvite {
  const trimmed = code.trim();
  if (trimmed.length > INVITE_MAX_CHARS) throw new Error("invite code too long");
  if (!trimmed.startsWith(INVITE_PREFIX)) throw new Error("not a PPM connection invite");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fromB64u(trimmed.slice(INVITE_PREFIX.length)).toString("utf8"));
  } catch {
    throw new Error("invite code is damaged");
  }
  if (!raw || typeof raw !== "object") throw new Error("invite code is damaged");
  if (typeof raw.ps !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw.ps)) throw new Error("invite code is damaged");
  if (typeof raw.exp !== "number" || !Number.isSafeInteger(raw.exp)) throw new Error("invite code is damaged");
  const invite: PeerInvite = {
    inviteId: fromB64u(String(raw.id), INVITE_ID_BYTES),
    inviterEphemeral: fromB64u(String(raw.ie), KEY_BYTES),
    inviterIdentity: fromB64u(String(raw.ii), KEY_BYTES),
    commitment: fromB64u(String(raw.c), KEY_BYTES),
    pairSecret: raw.ps,
    hint: canonicalHint(raw.hint as PeerTransportHint),
    label: cleanText(raw.label, LABEL_MAX),
    expiresAt: raw.exp,
  };
  if (!ed25519Verify(invite.inviterIdentity, inviteSigned(invite), fromB64u(String(raw.sig), 64))) {
    throw new Error("invite signature does not match");
  }
  if (invite.expiresAt <= now) throw new Error("invite has expired");
  return invite;
}

export function encodeAccept(accept: PeerAccept, identityPrivate: Uint8Array): string {
  const a = { ...accept, claimedName: cleanText(accept.claimedName, NAME_MAX) };
  const sig = ed25519Sign(identityPrivate, acceptSigned(a));
  return JSON.stringify({
    v: 1, kind: "accept", invite: b64u(a.inviteId), ae: b64u(a.acceptorEphemeral), ai: b64u(a.acceptorIdentity),
    ps: a.pairSecret, name: a.claimedName, sent_at: a.sentAt, sig: b64u(sig),
  });
}

/** Parse an `accept` and check its signature; the pair secret is checked by the caller against its hash. */
export function decodeAccept(text: string): PeerAccept {
  if (text.length > INVITE_MAX_CHARS) throw new Error("accept too long");
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || raw.v !== 1 || raw.kind !== "accept") throw new Error("not an accept");
  if (typeof raw.ps !== "string" || typeof raw.sent_at !== "number" || !Number.isSafeInteger(raw.sent_at)) throw new Error("malformed accept");
  const accept: PeerAccept = {
    inviteId: fromB64u(String(raw.invite), INVITE_ID_BYTES),
    acceptorEphemeral: fromB64u(String(raw.ae), KEY_BYTES),
    acceptorIdentity: fromB64u(String(raw.ai), KEY_BYTES),
    pairSecret: raw.ps,
    claimedName: cleanText(raw.name, NAME_MAX),
    sentAt: raw.sent_at,
  };
  if (!ed25519Verify(accept.acceptorIdentity, acceptSigned(accept), fromB64u(String(raw.sig), 64))) {
    throw new Error("accept signature does not match");
  }
  return accept;
}
