/**
 * `ppm.notify` — tell the person through PPM's own fan-out (push, Telegram, ntfy, PPM Cloud),
 * under the "Extensions" notification switch. The payload never carries the real session id:
 * `broadcast` coalesces a pending notification by `payload.sessionId || opts.coalesceKey`
 * (`notification.service.ts:90-91`), so a session id here would let this notification and the
 * chat's own "done" push cancel each other. Instead the session and project are folded into an
 * in-app `path` the same way `notificationPath` builds one, and a fresh coalesce key is minted
 * per call so only two calls made back to back (same extension, within the delay window) fold
 * into one notification.
 *
 * `notify:send` never waits out `broadcast`'s own delay (see `notifyAnswerTimeout` below): the
 * call answers "sent"/"off"/"replaced"/"seen" when that is known quickly, else "queued" at once,
 * while the real send still happens in the background.
 */
import type { RpcChannel } from "../extension-rpc.ts";
import { chatService } from "../chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { getExtensionById, getProjects, getSessionProjectPath, getSessionProvider, resolveMigratedSession } from "../db.service.ts";
import { isExtensionId, loggableExtensionId } from "./extension-id.ts";
import { checkNotifyOpen, declaredCommands } from "./extension-notify-open.ts";
import { createSlidingWindowLimiter } from "../sliding-window-limiter.ts";
import { notificationService, type BroadcastOptions, type BroadcastOutcome, type NotificationPayload } from "../notification.service.ts";
import { notificationPath } from "../notification-format.ts";
import { buildExtensionDeepLink } from "../../shared/extension-deep-link.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("extension-notify");

const TITLE_MAX_CHARS = 120;
const BODY_MAX_CHARS = 1000;
const RATE_LIMIT_WINDOW_MS = 3_600_000;
const RATE_LIMIT_MAX = 30;
/** Far more than PPM ever has installed extensions at once. */
const RATE_LIMIT_MAX_KEYS = 256;
/** Same rule `notificationPath` uses: an in-app path, never one that could leave the origin. */
const IN_APP_PATH = /^\/(?![/\\])/;

export type NotifySendErrorCode = "BAD_REQUEST" | "RATE_LIMITED";

export class NotifySendError extends Error {
  readonly code: NotifySendErrorCode;
  constructor(code: NotifySendErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "NotifySendError";
  }
}

/** `BroadcastOutcome` plus "queued": accepted, but `notify:send` answered before the
 *  notification's own delay (up to 60s by default) decided whether it was actually sent. */
export type NotifySendOutcome = BroadcastOutcome | "queued";

export type NotifySendWire =
  | { ok: true; result: NotifySendOutcome }
  | { ok: false; error: { code: NotifySendErrorCode; message: string } };

/**
 * Test seam: how long `notify:send` waits for `broadcast`'s real outcome before answering
 * "queued" instead. `broadcast` does not resolve until the notification delay elapses
 * (60s by default) or the call is switched off — far past the extension RPC's 10s timeout, so
 * every awaited `ppm.notify` used to fail with "RPC timeout: notify:send" even though PPM still
 * sent the notification. A fast outcome (switched off, no delay configured, or the real send)
 * still wins this race and is returned as-is; a slow one still happens, just unobserved by this
 * call's answer.
 */
export const notifyAnswerTimeout = { ms: 2_000 };

const PENDING = Symbol("notify-send-pending");

export interface ExtensionNotifyDeps {
  isKnownExtension(id: string): boolean;
  displayNameOf(id: string): string;
  /** The session's own provider, resolved past any migration; null when it names nothing. */
  resolveSessionProvider(sessionId: string): { sessionId: string; providerId: string } | null;
  projectExists(name: string): boolean;
  /** The command ids the extension declared in its own manifest. */
  commandsOf(id: string): string[];
  broadcast(type: "extension", payload: NotificationPayload, opts: BroadcastOptions): Promise<BroadcastOutcome>;
}

const defaultDeps: ExtensionNotifyDeps = {
  isKnownExtension: (id) => getExtensionById(id)?.enabled === 1,
  displayNameOf: (id) => getExtensionById(id)?.display_name || id,
  resolveSessionProvider(sessionId) {
    const resolved = resolveMigratedSession(sessionId);
    const live = chatService.getSession(resolved);
    if (!live && !getSessionProjectPath(resolved)) return null;
    const providerId = live?.providerId ?? getSessionProvider(resolved) ?? providerRegistry.getDefault().id;
    return { sessionId: resolved, providerId };
  },
  projectExists: (name) => getProjects().some((row) => row.name === name),
  commandsOf: declaredCommands,
  broadcast: (type, payload, opts) => notificationService.broadcast(type, payload, opts),
};

/** Test seam: the clock the rate limiter reads. */
export const extensionNotifyClock = { now: (): number => Date.now() };

const limiter = createSlidingWindowLimiter(
  { windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX },
  { maxKeys: RATE_LIMIT_MAX_KEYS },
);

/** Forget every count; for tests. */
export function resetExtensionNotifyLimit(): void {
  limiter.reset();
}

function paramsOf(params: unknown[]): Record<string, unknown> {
  const first = params[0];
  return first && typeof first === "object" ? first as Record<string, unknown> : {};
}

const bad = (message: string) => new NotifySendError("BAD_REQUEST", message);

function requireExtension(p: Record<string, unknown>, deps: ExtensionNotifyDeps): string {
  if (!isExtensionId(p.extensionId) || !deps.isKnownExtension(p.extensionId)) {
    throw bad("extensionId must name an installed, enabled extension");
  }
  return p.extensionId;
}

function requireTitle(p: Record<string, unknown>): string {
  const title = p.title;
  if (typeof title !== "string" || title.length < 1 || title.length > TITLE_MAX_CHARS) {
    throw bad(`title must be 1 to ${TITLE_MAX_CHARS} characters`);
  }
  return title;
}

function requireBody(p: Record<string, unknown>): string {
  const body = p.body;
  if (typeof body !== "string" || body.length > BODY_MAX_CHARS) {
    throw bad(`body must be a string of at most ${BODY_MAX_CHARS} characters`);
  }
  return body;
}

export function registerExtensionNotifyHandlers(rpc: RpcChannel, deps: ExtensionNotifyDeps = defaultDeps): void {
  rpc.onRequest("notify:send", async (params): Promise<NotifySendWire> => {
    try {
      const p = paramsOf(params);
      const extensionId = requireExtension(p, deps);
      const title = requireTitle(p);
      const body = requireBody(p);
      // One destination per notification: a link cannot open a chat, a path and a panel at once.
      if ([p.open, p.sessionId, p.path].filter((v) => v !== undefined).length > 1) {
        throw bad("Give at most one of open, sessionId or path");
      }

      let projectName: string | undefined;
      if (p.projectName !== undefined) {
        if (typeof p.projectName !== "string" || !p.projectName) throw bad("projectName must be a non-empty string");
        if (!deps.projectExists(p.projectName)) throw bad(`Project "${p.projectName}" is not registered`);
        projectName = p.projectName;
      }

      let sessionId: string | undefined;
      let providerId = typeof p.providerId === "string" && p.providerId ? p.providerId : undefined;
      if (p.sessionId !== undefined) {
        if (typeof p.sessionId !== "string" || !p.sessionId) throw bad("sessionId must be a non-empty string");
        const resolved = deps.resolveSessionProvider(p.sessionId);
        if (!resolved) throw bad("sessionId does not name a session that exists");
        sessionId = resolved.sessionId;
        if (!providerId) providerId = resolved.providerId;
      }

      let explicitPath: string | undefined;
      if (p.path !== undefined) {
        if (typeof p.path !== "string" || !IN_APP_PATH.test(p.path)) throw bad('path must be an in-app path, such as "/project/name"');
        explicitPath = p.path;
      }

      if (p.open !== undefined) {
        const checked = checkNotifyOpen(p.open, deps.commandsOf(extensionId));
        if (!checked.ok) throw bad(checked.message);
        explicitPath = buildExtensionDeepLink({ projectName, open: checked.open });
      }

      // Counted only once the request is known to be good: a refused call sends nothing.
      if (limiter.take(extensionId, extensionNotifyClock.now())) {
        log.warn(`notify.send refused: ${loggableExtensionId(extensionId)} is over ${RATE_LIMIT_MAX}/hour`);
        throw new NotifySendError("RATE_LIMITED", `At most ${RATE_LIMIT_MAX} notifications an hour per extension`);
      }

      const payload: NotificationPayload = {
        title: `${deps.displayNameOf(extensionId)}: ${title}`,
        body,
        project: projectName ?? "",
        sessionId: "",
        ...(providerId && { providerId }),
        path: notificationPath({ project: projectName ?? "", sessionId: sessionId ?? "", providerId, path: explicitPath }),
      };
      const broadcastPromise = deps.broadcast("extension", payload, { coalesceKey: `ext:${extensionId}:${crypto.randomUUID()}` });
      // Never let the detached promise become an unhandled rejection once this call has
      // already answered "queued" and moved on.
      broadcastPromise.catch((error) => {
        log.debug(`notify.send broadcast failed after answering: ${error instanceof Error ? error.message : String(error)}`);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof PENDING>((resolve) => {
        timer = setTimeout(() => resolve(PENDING), notifyAnswerTimeout.ms);
      });
      const outcome = await Promise.race([broadcastPromise, timeout]).finally(() => clearTimeout(timer));
      return { ok: true, result: outcome === PENDING ? "queued" : outcome };
    } catch (error) {
      const code = error instanceof NotifySendError ? error.code : "BAD_REQUEST";
      const message = error instanceof Error ? error.message : String(error);
      log.debug(`notify.send failed: ${message}`);
      return { ok: false, error: { code, message } };
    }
  });
}
