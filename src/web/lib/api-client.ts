import { toast } from "sonner";
import { wipeBrowserCaches } from "./browser-cache/wipe-browser-caches";

const TOKEN_KEY = "ppm-auth-token";
const RELOAD_GUARD_KEY = "ppm-auth-reload-ts";

/** An audit log that stops recording must not fail silently — but one warning per session is enough. */
let auditFailureReported = false;

function warnOnAuditFailure(res: Response): void {
  const reason = res.headers.get("x-ppm-audit-error");
  if (!reason || auditFailureReported) return;
  auditFailureReported = true;
  toast.error("Query audit log is not recording", { description: reason });
}

/** GETs currently awaiting a response, keyed by absolute URL. See ApiClient.get. */
const pendingGets = new Map<string, { promise: Promise<unknown>; startedAt: number }>();

/**
 * How long a GET may wait for response headers. Browsers do not time a stalled
 * fetch out on their own, and a request that never settles keeps its
 * `pendingGets` slot forever — every later caller of that URL then inherits the
 * stall, and UI gated on the response stays hidden until a page reload.
 *
 * The clock stops once headers arrive, so transcripts, file reads and other
 * large bodies may still take as long as the connection needs. Generous enough
 * for endpoints that spawn a CLI or hit a registry before answering.
 */
const RESPONSE_TIMEOUT_MS = 30_000;

/**
 * A request the server answered with a failure: `{ ok: false }`, or a body that is not JSON.
 *
 * The message is the server's own, exactly what a plain `Error` carried before, so a caller that
 * only shows `e.message` is unaffected. `status` is there for the ones that must tell "this
 * resource is gone" (404) from any other failure whose wording happens to say "not found", and
 * the whole body (null when it was not JSON) for callers that branch on more than the message — a
 * `DB_DRIVER_MISSING` answer names the driver to offer for install.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  /** The body's machine-readable `code`, when it has one. */
  get code(): string | undefined {
    const code = (this.body as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : undefined;
  }
}

/**
 * Asked when a database connection that keeps no password answered `428 DB_LOGIN_REQUIRED`, i.e.
 * the server holds no login for it yet. Database Log In registers itself here: it resolves true
 * once the server holds one, and the request goes again — it was refused before anything ran, so
 * sending it twice is safe whatever its method. Resolving false (the dialog was closed) lets the
 * 428 reach the caller as an `ApiError`, as it would with nothing registered.
 */
export type DbLoginHandler = (body: unknown) => Promise<boolean>;

let dbLoginHandler: DbLoginHandler | null = null;

export function setDbLoginHandler(handler: DbLoginHandler | null): void {
  dbLoginHandler = handler;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /**
   * false: a 428 is the caller's own to answer. The connection form's Test is one — it logs in
   * with what the form holds, which no saved connection has yet.
   */
  dbLogin?: boolean;
}

/** `reason` is only guaranteed on newer engines; never propagate `undefined`. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

export class ApiClient {
  private baseUrl: string;
  private responseTimeoutMs: number;

  constructor(baseUrl = "", responseTimeoutMs = RESPONSE_TIMEOUT_MS) {
    this.baseUrl = baseUrl;
    this.responseTimeoutMs = responseTimeoutMs;
  }

  private getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  private headers(): HeadersInit {
    const h: HeadersInit = { "Content-Type": "application/json" };
    const token = this.getToken();
    if (token) h["Authorization"] = `Bearer ${token}`;
    // Lets the server tell a browser session apart from an automated caller in audit logs.
    h["x-ppm-client"] = "web";
    return h;
  }

  /**
   * Auto-unwraps {ok, data} envelope. Returns T directly.
   *
   * Concurrent GETs of the same path share one request. Several components ask for
   * the same project-scoped data when a chat tab mounts — measured 4 identical
   * `providers/claude/models` and 4 `chat/sessions` requests within 2ms of each
   * other on a single tab open. This is in-flight sharing only, NOT a response
   * cache: the entry is dropped as soon as it settles, so nothing goes stale.
   *
   * Sharing is also capped in time. The response timer stops once headers
   * arrive, so a request that stalls midway through its body never settles —
   * and an unsettled entry must not hold back every later caller of that URL.
   * Past that window a new caller starts its own request instead.
   *
   * Requests carrying an AbortSignal opt out — one caller aborting must not cancel
   * another's request.
   */
  get<T>(path: string, options?: { signal?: AbortSignal }): Promise<T> {
    if (options?.signal) return this.rawGet<T>(path, options.signal);

    const key = `${this.baseUrl}${path}`;
    const entry = pendingGets.get(key);
    if (entry && Date.now() - entry.startedAt < this.responseTimeoutMs) {
      return entry.promise as Promise<T>;
    }

    const promise = this.rawGet<T>(path).finally(() => {
      // Drop only our own entry — an abandoned request settling late must not
      // evict the newer one that replaced it.
      if (pendingGets.get(key)?.promise === promise) pendingGets.delete(key);
    });
    pendingGets.set(key, { promise, startedAt: Date.now() });
    return promise;
  }

  private async rawGet<T>(path: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortReason(signal);

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(abortReason(signal!));
    signal?.addEventListener("abort", forwardAbort, { once: true });

    // Each send has its own clock — the first, and the one after a database login — and it
    // stops once headers are in: the connection answered, and the body may legitimately be
    // large and slow.
    const send = async () => {
      const timer = setTimeout(
        () =>
          controller.abort(
            new DOMException(
              `No response after ${this.responseTimeoutMs}ms: ${path}`,
              "TimeoutError",
            ),
          ),
        this.responseTimeoutMs,
      );
      try {
        return await fetch(`${this.baseUrl}${path}`, {
          headers: this.headers(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      return await this.settle<T>(await send(), send);
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  /**
   * No default timeout, unlike `get`: a POST is not idempotent, so cutting one off
   * mid-flight can leave the server having done the work with nobody to tell. A
   * caller that would rather fail loudly than wait passes its own `signal`.
   */
  async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.send<T>("POST", path, body, options);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>("PUT", path, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>("PATCH", path, body);
  }

  async del(path: string, body?: unknown): Promise<void> {
    await this.send<void>("DELETE", path, body);
  }

  /**
   * A POST answered with a stream rather than one `{ok, data}` envelope: the response itself, its
   * body still to be read, once its status says the request was taken. A refusal comes back as
   * JSON and is thrown as `post` throws it — a database login asked for and given first included.
   */
  async postStream(path: string, body: unknown, options?: RequestOptions): Promise<Response> {
    const send = () => fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    const res = await this.withDbLogin(await send(), send, options);
    if (res.ok && res.body) {
      warnOnAuditFailure(res);
      return res;
    }
    await this.handleResponse<unknown>(res);
    throw new Error(res.ok ? "Empty response from server" : `Server error (HTTP ${res.status})`);
  }

  private async send<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const send = () => fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body != null ? JSON.stringify(body) : undefined,
      signal: options?.signal,
    });
    return this.settle<T>(await send(), send, options);
  }

  private async settle<T>(res: Response, send: () => Promise<Response>, options?: RequestOptions): Promise<T> {
    return this.handleResponse<T>(await this.withDbLogin(res, send, options));
  }

  /** The response, or — when it asks for a database login and one is given — the same request again. */
  private async withDbLogin(res: Response, send: () => Promise<Response>, options?: RequestOptions): Promise<Response> {
    if (res.status === 428 && options?.dbLogin !== false && dbLoginHandler) {
      const body: unknown = await res.clone().json().catch(() => null);
      if ((body as { code?: unknown } | null)?.code === "DB_LOGIN_REQUIRED" && await dbLoginHandler(body)) return send();
    }
    return res;
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    warnOnAuditFailure(res);

    if (res.status === 401) {
      clearAuthToken();
      // Guard against infinite reload loops: skip reload if we already reloaded within 3s
      const lastReload = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || "0");
      if (Date.now() - lastReload > 3000) {
        sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
        window.location.reload();
      }
      throw new Error("Unauthorized");
    }

    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new ApiError(res.ok ? "Empty response from server" : `Server error (HTTP ${res.status})`, res.status, null);
    }

    if (json.ok === false) {
      throw new ApiError(json.error ?? `HTTP ${res.status}`, res.status, json);
    }

    return json.data as T;
  }
}

export const api = new ApiClient();

/** Build project-scoped API path prefix */
export function projectUrl(projectName: string): string {
  return `/api/project/${encodeURIComponent(projectName)}`;
}

export function setAuthToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Drops the auth token and wipes every browser cache built on top of it — the
 * one path both the 401 handler above and a failed login (`login-screen.tsx`)
 * go through, so neither leaves stale project data behind for the next user
 * of this browser. The wipe itself is fire-and-forget: it never throws, and
 * nothing here needs to wait on it (a 401 reloads the page moments later).
 */
export function clearAuthToken() {
  localStorage.removeItem(TOKEN_KEY);
  void wipeBrowserCaches();
}

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
