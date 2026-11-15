/**
 * The browser's side of `/api/vault`: one function per route, and the reading of a refusal
 * (`attemptsLeft`, `retryAfterMs`) the Settings pane and the chat cards both show.
 *
 * Nothing here caches a value or a password: a revealed value lives in the component that asked
 * for it, and a password only in the input it was typed into.
 */
import { api, ApiError } from "@/lib/api-client";
import type {
  VaultCardAnswer, VaultCardAnswerResult, VaultItemKind, VaultItemMeta, VaultLockedTier, VaultStatus, VaultTier,
} from "../../shared/vault";

export interface VaultGrantInfo { tier: VaultLockedTier; expiresAt: number; settings: boolean }
export type VaultStatusResponse = VaultStatus & { grants: VaultGrantInfo[] };
export interface VaultItemValue extends VaultItemMeta { value: string; note?: string }
export type VaultPasswords = Partial<Record<VaultLockedTier, string>>;

const item = (id: string) => `/api/vault/items/${encodeURIComponent(id)}`;
/**
 * This page's own handle for the Secure tier's Settings unlock: random, kept in memory only, so the
 * unlock answers to this page and not to anything else holding PPM's auth token. A reload starts
 * a new one, i.e. locked.
 */
const PAGE_HANDLE = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Only a non-empty password goes on the wire: an empty one would read as "wrong" and cost an attempt. */
const pw = (password?: string) => ({ handle: PAGE_HANDLE, ...(password ? { password } : {}) });

export const vaultApi = {
  status: () => api.get<VaultStatusResponse>("/api/vault/status"),
  items: () => api.get<VaultItemMeta[]>("/api/vault/items"),
  enableTier: (tier: VaultLockedTier, password: string) => api.post<VaultStatusResponse>(`/api/vault/tiers/${tier}/enable`, { password }),
  changePassword: (tier: VaultLockedTier, oldPassword: string, newPassword: string) =>
    api.post<VaultStatusResponse>(`/api/vault/tiers/${tier}/password`, { oldPassword, newPassword }),
  deleteTier: (tier: VaultLockedTier, password: string) => api.post<{ removed: number }>(`/api/vault/tiers/${tier}/delete`, { password }),
  unlockSecure: (password: string) => api.post<{ openUntil: number }>("/api/vault/tiers/secure/unlock", { password, handle: PAGE_HANDLE }),
  lock: (tier?: VaultLockedTier) => api.post<{ closed: number }>("/api/vault/lock", tier ? { tier } : {}),
  addItem: (input: { tier: VaultTier; name: string; kind: VaultItemKind; value: string; note?: string; password?: string }) =>
    api.post<VaultItemMeta>("/api/vault/items", { ...input, ...pw(input.password) }),
  updateItem: (id: string, patch: { name?: string; kind?: VaultItemKind; value?: string; note?: string }, password?: string) =>
    api.patch<VaultItemMeta>(item(id), { ...patch, ...pw(password) }),
  deleteItem: (id: string, password?: string) => api.post<{ deleted: boolean }>(`${item(id)}/delete`, pw(password)),
  reveal: (id: string, password?: string) => api.post<VaultItemValue>(`${item(id)}/reveal`, pw(password)),
  move: (id: string, to: VaultTier, passwords: VaultPasswords) => {
    const sent: VaultPasswords = {};
    for (const [tier, value] of Object.entries(passwords) as [VaultLockedTier, string | undefined][]) if (value) sent[tier] = value;
    return api.post<VaultItemMeta>(`${item(id)}/move`, { to, passwords: sent, handle: PAGE_HANDLE });
  },
  answerCard: (requestId: string, answer: VaultCardAnswer) =>
    api.post<VaultCardAnswerResult>(`/api/vault/cards/${encodeURIComponent(requestId)}`, answer),
  cardPrefill: (requestId: string) => api.get<{ value: string | null }>(`/api/vault/cards/${encodeURIComponent(requestId)}/prefill`),
};

/** A refused vault request, read for what the UI has to say about it. */
export interface VaultFailure {
  message: string;
  status: number | null;
  /** Wrong passwords left before the next lock-out (a 403). */
  attemptsLeft?: number;
  /** Epoch ms until the tier takes a password again, when it is locked out. */
  lockedUntil?: number;
  /** 423 with no lock-out: the action needs the tier's password (the Settings unlock has ended). */
  needsPassword: boolean;
}

export function vaultFailure(e: unknown, now = Date.now()): VaultFailure {
  if (!(e instanceof ApiError)) return { message: e instanceof Error ? e.message : String(e), status: null, needsPassword: false };
  const body = (e.body ?? {}) as { attemptsLeft?: unknown; retryAfterMs?: unknown };
  const retryAfterMs = typeof body.retryAfterMs === "number" && body.retryAfterMs > 0 ? body.retryAfterMs : undefined;
  return {
    message: e.message,
    status: e.status,
    ...(typeof body.attemptsLeft === "number" ? { attemptsLeft: body.attemptsLeft } : {}),
    ...(retryAfterMs !== undefined ? { lockedUntil: now + retryAfterMs } : {}),
    needsPassword: e.status === 423 && retryAfterMs === undefined,
  };
}

/** "1 attempt left" / "Try again in 42 s" beside the server's own message. */
export function vaultFailureDetail(f: VaultFailure, now = Date.now()): string | null {
  if (f.lockedUntil !== undefined && f.lockedUntil > now) return `Try again in ${Math.ceil((f.lockedUntil - now) / 1000)} s.`;
  if (f.attemptsLeft !== undefined) return `${f.attemptsLeft} attempt${f.attemptsLeft === 1 ? "" : "s"} left.`;
  return null;
}

/** "4:12" for a countdown. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
