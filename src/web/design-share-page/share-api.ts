import { GUEST_KEY_HEADER, GUEST_VERSION_CHANGED, type DesignShareGuestInfo } from "../../shared/design-share-guest-types";
import type { GuestThread } from "./share-thread-model";

/**
 * The reviewer page's calls to `/s/<code>/…`. Nothing here reads or sends PPM's own token:
 * a write carries the reviewer's key and the cross-origin header pair, nothing else.
 *
 * Every failure is an {@link ShareApiError} whose `failure` says what the page should do:
 * `invalid` (the link no longer opens — say so and stop), `rate-limited` (wait), `network`
 * (try again later) or `error` with the server's message for the reviewer.
 */

export type ShareFailure =
  | { kind: "invalid" }
  | { kind: "rate-limited"; retryAfterMs: number }
  | { kind: "network" }
  | { kind: "error"; status: number; message: string; code?: string };

export class ShareApiError extends Error {
  constructor(readonly failure: ShareFailure) {
    super(failureMessage(failure));
  }
}

/** Seconds from a `Retry-After` header, at least one, defaulting to ten. */
export function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return (Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 10) * 1000;
}

/**
 * What a failed response means. `invalidOn404` is for the link-level reads (`/info`, the
 * thread list), where 404 can only mean the code stopped opening; on a write a 404 is the
 * thread that is gone, which the next poll shows.
 */
export function failureFromResponse(
  status: number, body: unknown, retryAfter: string | null, invalidOn404: boolean,
): ShareFailure {
  if (status === 404 && invalidOn404) return { kind: "invalid" };
  if (status === 429) return { kind: "rate-limited", retryAfterMs: retryAfterMs(retryAfter) };
  const raw = body && typeof body === "object" ? body as { error?: unknown; code?: unknown } : {};
  const message = typeof raw.error === "string" && raw.error ? raw.error.slice(0, 300) : "Something went wrong; try again";
  return { kind: "error", status, message, ...(typeof raw.code === "string" ? { code: raw.code } : {}) };
}

export function failureMessage(f: ShareFailure): string {
  switch (f.kind) {
    case "invalid": return "This link is no longer valid";
    case "rate-limited": return `Too many requests. Try again in ${Math.ceil(f.retryAfterMs / 1000)} s.`;
    case "network": return "Could not reach the server. Check your connection.";
    case "error": return f.message;
  }
}

/** The code in `/s/<code>`, or null for any other path. */
export function shareCodeFromPath(pathname: string): string | null {
  const m = /^\/s\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
  return m ? m[1]! : null;
}

async function call<T>(url: string, init: RequestInit, invalidOn404: boolean): Promise<{ data: T; res: Response }> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "omit", cache: "no-store", ...init });
  } catch {
    throw new ShareApiError({ kind: "network" });
  }
  const body: unknown = res.status === 304 ? null : await res.json().catch(() => null);
  if (!res.ok && res.status !== 304) {
    throw new ShareApiError(failureFromResponse(res.status, body, res.headers.get("retry-after"), invalidOn404));
  }
  return { data: (body as { data?: T } | null)?.data as T, res };
}

export function shareBase(code: string): string {
  return `/s/${encodeURIComponent(code)}`;
}

export async function fetchShareInfo(code: string): Promise<DesignShareGuestInfo> {
  return (await call<DesignShareGuestInfo>(`${shareBase(code)}/info`, {}, true)).data;
}

/**
 * The thread list and the version the link shows now, or `unchanged` when `etag` still
 * describes both (304: the ETag covers the version, so a re-pin always answers in full).
 */
export async function fetchThreads(
  code: string, key: string, etag: string | null,
): Promise<{ unchanged: true } | { unchanged: false; threads: GuestThread[]; versionId: string | null; etag: string | null }> {
  const headers: Record<string, string> = { [GUEST_KEY_HEADER]: key };
  if (etag) headers["If-None-Match"] = etag;
  const { data, res } = await call<{ threads: GuestThread[]; versionId?: unknown }>(`${shareBase(code)}/comments`, { headers }, true);
  if (res.status === 304) return { unchanged: true };
  const versionId = typeof data?.versionId === "string" ? data.versionId : null;
  return { unchanged: false, threads: data?.threads ?? [], versionId, etag: res.headers.get("etag") };
}

/** A write refused because the owner re-pinned the link since this page loaded. */
export function isVersionChanged(f: ShareFailure): boolean {
  return f.kind === "error" && f.code === GUEST_VERSION_CHANGED;
}

function write<T>(code: string, key: string, method: string, path: string, body: object): Promise<T> {
  return call<T>(`${shareBase(code)}/comments${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-PPM-Request": "1", [GUEST_KEY_HEADER]: key },
    body: JSON.stringify(body),
  }, false).then((r) => r.data);
}

const seg = (id: string): string => `/${encodeURIComponent(id)}`;

/** Every write the reviewer can make; each answers the thread as it now stands. */
export function shareWrites(code: string, key: string) {
  const thread = (p: Promise<{ thread: GuestThread }>) => p.then((d) => d.thread);
  return {
    /** `versionId`: the version this page shows, which the comment's anchor was read from. */
    addThread: (anchor: unknown, body: string, name: string, versionId: string) =>
      thread(write(code, key, "POST", "", { anchor, body, name, versionId })),
    reply: (id: string, body: string, name: string) =>
      thread(write(code, key, "POST", `${seg(id)}/replies`, { body, name })),
    editThread: (id: string, body: string) => thread(write(code, key, "PATCH", seg(id), { body })),
    deleteThread: (id: string) => write<{ deleted: string }>(code, key, "DELETE", seg(id), {}).then(() => undefined),
    editReply: (id: string, replyId: string, body: string) =>
      thread(write(code, key, "PATCH", `${seg(id)}/replies${seg(replyId)}`, { body })),
    deleteReply: (id: string, replyId: string) =>
      thread(write(code, key, "DELETE", `${seg(id)}/replies${seg(replyId)}`, {})),
  };
}

export type ShareWrites = ReturnType<typeof shareWrites>;
