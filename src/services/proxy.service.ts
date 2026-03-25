import { getConfigValue, setConfigValue } from "./db.service.ts";
import { accountSelector } from "./account-selector.service.ts";
import { accountService } from "./account.service.ts";
import { randomBytes } from "node:crypto";

const PROXY_ENABLED_KEY = "proxy_enabled";
const PROXY_AUTH_KEY = "proxy_auth_key";

const ANTHROPIC_API_BASE = "https://api.anthropic.com";

class ProxyService {
  private requestCount = 0;

  isEnabled(): boolean {
    return getConfigValue(PROXY_ENABLED_KEY) === "true";
  }

  setEnabled(enabled: boolean): void {
    setConfigValue(PROXY_ENABLED_KEY, String(enabled));
  }

  getAuthKey(): string | null {
    return getConfigValue(PROXY_AUTH_KEY);
  }

  /** Generate a new random auth key */
  generateAuthKey(): string {
    const key = `ppm-proxy-${randomBytes(16).toString("hex")}`;
    setConfigValue(PROXY_AUTH_KEY, key);
    return key;
  }

  /** Set a custom auth key */
  setAuthKey(key: string): void {
    setConfigValue(PROXY_AUTH_KEY, key);
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  /**
   * Forward a request to Anthropic API using account rotation.
   * Returns a Response object (may be streaming SSE).
   */
  async forward(
    path: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
  ): Promise<Response> {
    // Pick account via rotation
    const account = accountSelector.next();
    if (!account) {
      return new Response(
        JSON.stringify({ type: "error", error: { type: "authentication_error", message: "No active accounts available" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    // Ensure token is fresh for OAuth accounts
    let token = account.accessToken;
    if (token.startsWith("sk-ant-oat")) {
      const fresh = await accountService.ensureFreshToken(account.id);
      if (fresh) token = fresh.accessToken;
    }

    // Build upstream headers — forward relevant Anthropic headers
    const upstreamHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "ppm-proxy/1.0",
    };

    // Set auth based on token type
    if (token.startsWith("sk-ant-oat")) {
      upstreamHeaders["Authorization"] = `Bearer ${token}`;
      upstreamHeaders["anthropic-beta"] = headers["anthropic-beta"] || "oauth-2025-04-20";
    } else {
      upstreamHeaders["x-api-key"] = token;
    }

    // Forward anthropic-version header
    if (headers["anthropic-version"]) {
      upstreamHeaders["anthropic-version"] = headers["anthropic-version"];
    }
    // Forward anthropic-beta if present from client
    if (headers["anthropic-beta"]) {
      upstreamHeaders["anthropic-beta"] = headers["anthropic-beta"];
    }

    const url = `${ANTHROPIC_API_BASE}${path}`;
    console.log(`[proxy] ${method} ${path} → account ${account.email ?? account.id}`);

    try {
      const upstream = await fetch(url, {
        method,
        headers: upstreamHeaders,
        body: body || undefined,
        signal: AbortSignal.timeout(300_000), // 5min timeout for long streaming
      });

      this.requestCount++;

      // Handle rate limit / auth errors for account rotation
      if (upstream.status === 429) {
        accountSelector.onRateLimit(account.id);
        console.log(`[proxy] 429 from Anthropic — account ${account.email ?? account.id} rate limited`);
      } else if (upstream.status === 401) {
        accountSelector.onAuthError(account.id);
        console.log(`[proxy] 401 from Anthropic — account ${account.email ?? account.id} auth error`);
      } else if (upstream.status >= 200 && upstream.status < 300) {
        accountSelector.onSuccess(account.id);
      }

      // Stream response back as-is (preserves SSE for streaming)
      const responseHeaders = new Headers();
      // Forward key response headers
      for (const key of ["content-type", "x-request-id", "request-id"]) {
        const val = upstream.headers.get(key);
        if (val) responseHeaders.set(key, val);
      }
      // CORS for external tools
      responseHeaders.set("Access-Control-Allow-Origin", "*");

      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } catch (e) {
      console.error(`[proxy] Error forwarding to Anthropic:`, (e as Error).message);
      return new Response(
        JSON.stringify({ type: "error", error: { type: "api_error", message: (e as Error).message } }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }
  }
}

export const proxyService = new ProxyService();
