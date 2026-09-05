/**
 * Pure/self-contained helpers for the login session state machine, split out
 * of `cloudflared-login.service.ts` purely to keep that file under the
 * project's line-count guideline — none of these hold their own module state.
 */
import { existsSync, renameSync } from "node:fs";
import { getOriginCertPath } from "./cloudflared-cert.ts";
import { resolveTunnelConfig } from "./named-tunnel-config.ts";
import { configService } from "../config.service.ts";
import { extractLoginUrl, isLoginSuccess } from "./login-output-parser.ts";

const VERIFY_TIMEOUT_MS = 10_000;

/** Live-checks an apiToken against Cloudflare rather than trusting the cert file alone. */
export async function verifyCertLive(apiToken: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const json = (await res.json().catch(() => null)) as { success?: boolean } | null;
    return json?.success === true;
  } catch {
    return false;
  }
}

/** True when no `tunnel` identity is pinned yet, or the cert matches the pinned one. */
export function pinsMatch(cert: { zoneID: string; accountID: string }): boolean {
  const resolved = resolveTunnelConfig(configService.get("tunnel"));
  if (resolved.mode !== "named") return true;
  return resolved.zoneID === cert.zoneID && resolved.accountID === cert.accountID;
}

/** Rename an existing cert.pem aside so a stale/foreign cert can never block a fresh login. */
export function renameCertAside(): void {
  const path = getOriginCertPath();
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  renameSync(path, `${path}.bak-${stamp}`);
}

/**
 * Read a login process's stdout/stderr stream incrementally: report the URL
 * as soon as it appears, and signal success the moment the success line
 * shows up (without waiting for the process to exit). `isSuperseded` lets the
 * caller bail out the instant this stream stops being the "current" one
 * (cancel/retry/timeout raced ahead of us).
 */
export async function pumpLoginStream(
  stream: ReadableStream<Uint8Array>,
  hooks: { isSuperseded: () => boolean; hasUrl: () => boolean; onUrl: (url: string) => void; onSuccess: () => void },
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (hooks.isSuperseded()) return;

      const chunk = decoder.decode(value, { stream: true });
      buffered += chunk;

      if (!hooks.hasUrl()) {
        const url = extractLoginUrl(chunk) ?? extractLoginUrl(buffered);
        if (url) hooks.onUrl(url);
      }
      if (isLoginSuccess(chunk) || isLoginSuccess(buffered)) {
        hooks.onSuccess();
        return;
      }
    }
  } catch {
    // Stream closed underneath us (process killed) — a terminal state has
    // already been (or is about to be) set by whichever timer/cancel did it.
  }
}
