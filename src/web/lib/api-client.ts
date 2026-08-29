import { toast } from "sonner";

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
const pendingGets = new Map<string, Promise<unknown>>();

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
   * Requests carrying an AbortSignal opt out — one caller aborting must not cancel
   * another's request.
   */
  get<T>(path: string, options?: { signal?: AbortSignal }): Promise<T> {
    if (options?.signal) return this.rawGet<T>(path, options.signal);

    const key = `${this.baseUrl}${path}`;
    const inFlight = pendingGets.get(key);
    if (inFlight) return inFlight as Promise<T>;

    const p = this.rawGet<T>(path).finally(() => pendingGets.delete(key));
    pendingGets.set(key, p);
    return p;
  }

  private async rawGet<T>(path: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortReason(signal);

    const controller = new AbortController();
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
    const forwardAbort = () => controller.abort(abortReason(signal!));
    signal?.addEventListener("abort", forwardAbort, { once: true });

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: this.headers(),
        signal: controller.signal,
      });
      // Headers are in, so the connection answered — stop the clock before
      // reading the body, which may legitimately be large and slow.
      clearTimeout(timer);
      return await this.handleResponse<T>(res);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    return this.handleResponse<T>(res);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: this.headers(),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    return this.handleResponse<T>(res);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers: this.headers(),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    return this.handleResponse<T>(res);
  }

  async del(path: string, body?: unknown): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers(),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    await this.handleResponse<void>(res);
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    warnOnAuditFailure(res);

    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
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
      throw new Error(res.ok ? "Empty response from server" : `Server error (HTTP ${res.status})`);
    }

    if (json.ok === false) {
      throw new Error(json.error ?? `HTTP ${res.status}`);
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

export function clearAuthToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
