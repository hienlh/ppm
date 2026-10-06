/**
 * ntfy (ntfy.sh, or a server of your own): one JSON publish per notification.
 *
 * JSON rather than ntfy's header form, because a header value has to be ASCII (or
 * RFC 2047-encoded) and titles here carry session and device names in any language.
 */
import { configService } from "./config.service.ts";
import type { NtfyConfig } from "../types/config.ts";
import type { NotificationPayload } from "./notification.service.ts";
import { formatPushNotification } from "./notification-format.ts";
import { notificationLink } from "./notification-link.ts";

const TIMEOUT_MS = 10_000;
/** ntfy's "high": a heads-up with sound on Android, where "default" can stay silent. */
const URGENT_PRIORITY = 4;

export interface NtfyMessage {
  title: string;
  message: string;
  priority?: number;
  click?: string;
}

/** A failure worded for the person setting ntfy up. 400 = fix the settings, 502 = the server or the network. */
export class NtfyError extends Error {
  constructor(message: string, readonly status: 400 | 502) {
    super(message);
  }
}

/** The saved server and topic, or null while ntfy is not set up. */
export function savedNtfyConfig(): NtfyConfig | null {
  const config = configService.get("ntfy");
  return config?.server && config.topic ? config : null;
}

function hostOf(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

async function ntfyFetch(config: NtfyConfig, path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${config.server}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...(config.token && { Authorization: `Bearer ${config.token}` }) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // The whole base URL, scheme included: a bare host is tried over https, which is the
    // answer when an http-only server seems not to be there.
    throw new NtfyError(`Could not reach ${config.server}: ${(e as Error).message}`, 502);
  }
}

/** ntfy answers an error as `{"code":40301,"http":403,"error":"forbidden",…}`. */
async function refusal(res: Response, config: NtfyConfig): Promise<NtfyError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const said = typeof body?.error === "string" ? body.error : res.statusText || "error";
  const host = hostOf(config.server);
  if (res.status === 401) return new NtfyError(`${host} did not accept the access token (${said})`, 502);
  if (res.status === 403) {
    return new NtfyError(
      config.token
        ? `This access token may not publish to "${config.topic}" on ${host} (${said})`
        : `${host} needs an access token to publish to "${config.topic}" (${said})`,
      502,
    );
  }
  return new NtfyError(`${host} answered ${res.status}: ${said}`, 502);
}

export async function publishToNtfy(config: NtfyConfig, message: NtfyMessage): Promise<void> {
  const res = await ntfyFetch(config, "/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: config.topic, ...message }),
  });
  if (!res.ok) throw await refusal(res, config);
  await res.body?.cancel();
}

/**
 * Before saving: the address must answer as an ntfy server, and a token must be one it
 * accepts. Whether the token may publish to the topic only a publish can tell, which is
 * what Send a test is for.
 */
export async function checkNtfyServer(config: NtfyConfig): Promise<void> {
  const host = hostOf(config.server);
  const health = await ntfyFetch({ ...config, token: "" }, "/v1/health");
  const answer = (await health.json().catch(() => null)) as { healthy?: unknown } | null;
  if (!health.ok || answer?.healthy !== true) throw new NtfyError(`${host} does not answer like an ntfy server`, 400);
  if (!config.token) return;
  // The account answer lists the user's tokens, this one included, so only its status is read.
  // A 404 is a server without accounts, where the token is simply unused.
  const account = await ntfyFetch(config, "/v1/account");
  await account.body?.cancel();
  if (account.status === 401) throw new NtfyError(`${host} did not accept the access token`, 400);
}

class NtfyNotificationService {
  /** Publish one notification. Nothing while ntfy is not set up; throws when the server refuses it. */
  async send(payload: NotificationPayload, urgent: boolean): Promise<void> {
    const config = savedNtfyConfig();
    if (!config) return;
    const { title, body } = formatPushNotification(payload, deviceName());
    await publishToNtfy(config, {
      title,
      message: body,
      ...(urgent && { priority: URGENT_PRIORITY }),
      click: await notificationLink(payload),
    });
  }

  async sendTest(): Promise<void> {
    const config = savedNtfyConfig();
    if (!config) throw new NtfyError("Set up ntfy first", 400);
    await publishToNtfy(config, {
      title: `Test · ${deviceName()}`,
      message: "ntfy notifications from PPM are working.",
      click: await notificationLink({ project: "", sessionId: "" }),
    });
  }
}

function deviceName(): string {
  return (configService.get("device_name") as string) || "PPM";
}

/** Singleton, so tests can stand in for the channel the way they do for push and Telegram. */
export const ntfyService = new NtfyNotificationService();
