/**
 * The browser's side of `/api/vault`: one function per route, and the reading of a refusal
 * (`attemptsLeft`, `retryAfterMs`) the Settings pane and the chat cards both show.
 *
 * Nothing here caches a value or a password: a revealed value lives in the component that asked
 * for it, and a password only in the input it was typed into.
 */
import { api, ApiError, getAuthToken } from "@/lib/api-client";
import type {
  VaultAttachmentMeta, VaultCardAnswer, VaultCardAnswerResult, VaultItemKind, VaultItemMeta, VaultLockedTier, VaultStatus, VaultTier,
} from "../../shared/vault";

export interface VaultGrantInfo { tier: VaultLockedTier; expiresAt: number; settings: boolean }
export type VaultStatusResponse = VaultStatus & { grants: VaultGrantInfo[] };
export interface VaultItemValue extends VaultItemMeta { value: string; note?: string }
export type VaultPasswords = Partial<Record<VaultLockedTier, string>>;

const item = (id: string) => `/api/vault/items/${encodeURIComponent(id)}`;
const file = (id: string) => `/api/vault/files/${encodeURIComponent(id)}`;

/** The auth header for the two requests `api` cannot make (a multipart body, a binary answer). */
function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), "x-ppm-client": "web" };
}

/** The original file name from `Content-Disposition: …; filename*=UTF-8''…`, else "file". */
export function fileNameOf(header: string | null): string {
  const m = header ? /filename\*=UTF-8''([^;]+)/i.exec(header) : null;
  if (!m) return "file";
  try {
    return decodeURIComponent(m[1]!) || "file";
  } catch {
    return "file";
  }
}

/** A `{ ok, data }` answer read the way `api` reads one, refusals as `ApiError`. */
async function unwrap<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: string } | null;
  if (!res.ok || !body?.ok) throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status, body);
  return body.data as T;
}
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
  uploadFile: async (itemId: string, file: Blob, fileName: string, opts: { label?: string; password?: string } = {}) => {
    const form = new FormData();
    form.set("file", file, fileName);
    form.set("handle", PAGE_HANDLE);
    if (opts.label) form.set("label", opts.label);
    if (opts.password) form.set("password", opts.password);
    const res = await fetch(`${item(itemId)}/files`, { method: "POST", headers: authHeaders(), body: form });
    return unwrap<VaultAttachmentMeta>(res);
  },
  /** The decrypted file as a Blob, for this page only: nothing is cached and the caller drops it. */
  openFile: async (fileId: string, opts: { password?: string; download?: boolean } = {}): Promise<{ blob: Blob; fileName: string }> => {
    const res = await fetch(`${file(fileId)}/content`, {
      method: "POST",
      cache: "no-store",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ...pw(opts.password), ...(opts.download ? { download: true } : {}) }),
    });
    if (!res.ok) await unwrap(res);
    return { blob: await res.blob(), fileName: fileNameOf(res.headers.get("content-disposition")) };
  },
  renameFile: (fileId: string, label: string, password?: string) => api.patch<VaultAttachmentMeta>(file(fileId), { label, ...pw(password) }),
  deleteFile: (fileId: string, password?: string) => api.post<{ deleted: boolean }>(`${file(fileId)}/delete`, pw(password)),
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
