import { getConfigValue, setConfigValue, insertProxyRequest, type ProxyRequestStatus } from "./db.service.ts";
import { accountSelector } from "./account-selector.service.ts";
import { accountService } from "./account.service.ts";
import { forwardViaSdk } from "./proxy-sdk-bridge.ts";
import { forwardOpenAiViaSdk } from "./proxy-openai-bridge.ts";
import { randomBytes } from "node:crypto";

const PROXY_ENABLED_KEY = "proxy_enabled";
const PROXY_AUTH_KEY = "proxy_auth_key";

const ANTHROPIC_API_BASE = "https://api.anthropic.com";

export interface ProxyCallerMeta {
  callerIp?: string;
  callerUa?: string;
}

function parseModel(body: string | null): string | undefined {
  if (!body) return undefined;
  try {
    return JSON.parse(body).model as string | undefined;
  } catch {
    return undefined;
  }
}

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
   * OAuth accounts (sk-ant-oat-*) → SDK query() bridge.
   * API key accounts → direct HTTP forward to api.anthropic.com.
   */
  async forward(
    path: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    caller?: ProxyCallerMeta,
  ): Promise<Response> {
    // Pick account via rotation
    const account = accountSelector.next();
    if (!account) {
      insertProxyRequest({
        endpoint: path, model: parseModel(body),
        callerIp: caller?.callerIp, callerUa: caller?.callerUa, status: "error",
      });
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

    // OAuth tokens: route through SDK query() — direct API doesn't work for Claude Max/Pro
    if (token.startsWith("sk-ant-oat") && body && path === "/v1/messages") {
      const start = performance.now();
      try {
        const parsed = JSON.parse(body);
        this.requestCount++;
        const response = await forwardViaSdk(parsed, { id: account.id, email: account.email, accessToken: token });
        const durationMs = Math.round(performance.now() - start);
        insertProxyRequest({
          endpoint: path, model: parsed.model, accountId: account.id, accountLabel: account.email ?? account.id,
          callerIp: caller?.callerIp, callerUa: caller?.callerUa, status: "success", durationMs,
        });
        console.log(`[proxy] ${method} ${path} → ${account.email ?? account.id} (sdk) ${durationMs}ms caller=${caller?.callerIp ?? "unknown"}`);
        return response;
      } catch (e) {
        insertProxyRequest({
          endpoint: path, model: parseModel(body), accountId: account.id, accountLabel: account.email ?? account.id,
          callerIp: caller?.callerIp, callerUa: caller?.callerUa, status: "error",
          durationMs: Math.round(performance.now() - start),
        });
        console.error(`[proxy] SDK bridge error:`, (e as Error).message);
        return new Response(
          JSON.stringify({ type: "error", error: { type: "api_error", message: (e as Error).message } }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // API key accounts: direct HTTP forward to Anthropic API
    return this.forwardDirect(path, method, headers, body, token, account, caller);
  }

  /**
   * Forward an OpenAI-format chat completions request via SDK query().
   * Always uses SDK bridge (works for both OAuth and API key accounts).
   */
  async forwardOpenAi(body: string, caller?: ProxyCallerMeta): Promise<Response> {
    const account = accountSelector.next();
    if (!account) {
      insertProxyRequest({
        endpoint: "/v1/chat/completions", model: parseModel(body),
        callerIp: caller?.callerIp, callerUa: caller?.callerUa, status: "error",
      });
      return new Response(
        JSON.stringify({ error: { message: "No active accounts available", type: "server_error" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    let token = account.accessToken;
    if (token.startsWith("sk-ant-oat")) {
      const fresh = await accountService.ensureFreshToken(account.id);
      if (fresh) token = fresh.accessToken;
    }

    const start = performance.now();
    try {
      const parsed = JSON.parse(body);
      this.requestCount++;
      const response = await forwardOpenAiViaSdk(parsed, { id: account.id, email: account.email, accessToken: token });
      const durationMs = Math.round(performance.now() - start);
      insertProxyRequest({
        endpoint: "/v1/chat/completions", model: parsed.model, accountId: account.id, accountLabel: account.email ?? account.id,
        callerIp: caller?.callerIp, callerUa: caller?.callerUa, status: "success", durationMs,
      });
      console.log(`[proxy] POST /v1/chat/completions → ${account.email ?? account.id} (openai) ${durationMs}ms caller=${caller?.callerIp ?? "unknown"}`);
      return response;
    } catch (e) {
      insertProxyRequest({
        endpoint: "/v1/chat/completions", model: parseModel(body), accountId: account.id, accountLabel: account.email ?? account.id,
        callerIp: caller?.callerIp, callerUa: caller?.callerUa, status: "error",
        durationMs: Math.round(performance.now() - start),
      });
      console.error(`[proxy] OpenAI bridge error:`, (e as Error).message);
      return new Response(
        JSON.stringify({ error: { message: (e as Error).message, type: "server_error" } }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  /** Direct HTTP forward for API key accounts */
  private async forwardDirect(
    path: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    token: string,
    account: { id: string; email: string | null },
    caller?: ProxyCallerMeta,
  ): Promise<Response> {
    const upstreamHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "ppm-proxy/1.0",
      "x-api-key": token,
    };
    if (headers["anthropic-version"]) upstreamHeaders["anthropic-version"] = headers["anthropic-version"];
    if (headers["anthropic-beta"]) upstreamHeaders["anthropic-beta"] = headers["anthropic-beta"];

    const url = `${ANTHROPIC_API_BASE}${path}`;
    const accountLabel = account.email ?? account.id;
    const start = performance.now();

    try {
      const upstream = await fetch(url, {
        method,
        headers: upstreamHeaders,
        body: body || undefined,
        signal: AbortSignal.timeout(300_000),
      });

      this.requestCount++;
      const durationMs = Math.round(performance.now() - start);

      let status: ProxyRequestStatus = "error";
      if (upstream.status === 429) {
        accountSelector.onRateLimit(account.id);
        status = "rate_limited";
        console.log(`[proxy] 429 — account ${accountLabel} rate limited`);
      } else if (upstream.status === 401) {
        accountSelector.onAuthError(account.id);
        console.log(`[proxy] 401 — account ${accountLabel} auth error`);
      } else if (upstream.status >= 200 && upstream.status < 300) {
        accountSelector.onSuccess(account.id);
        status = "success";
      }

      insertProxyRequest({
        endpoint: path, model: parseModel(body), accountId: account.id, accountLabel,
        callerIp: caller?.callerIp, callerUa: caller?.callerUa, status, durationMs,
      });
      console.log(`[proxy] ${method} ${path} → ${accountLabel} (direct) ${durationMs}ms caller=${caller?.callerIp ?? "unknown"}`);

      const responseHeaders = new Headers();
      for (const key of ["content-type", "x-request-id", "request-id"]) {
        const val = upstream.headers.get(key);
        if (val) responseHeaders.set(key, val);
      }
      responseHeaders.set("Access-Control-Allow-Origin", "*");

      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch (e) {
      insertProxyRequest({
        endpoint: path, model: parseModel(body), accountId: account.id, accountLabel,
        callerIp: caller?.callerIp, callerUa: caller?.callerUa, status: "error",
        durationMs: Math.round(performance.now() - start),
      });
      console.error(`[proxy] Error forwarding:`, (e as Error).message);
      return new Response(
        JSON.stringify({ type: "error", error: { type: "api_error", message: (e as Error).message } }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }
  }
}

export const proxyService = new ProxyService();
