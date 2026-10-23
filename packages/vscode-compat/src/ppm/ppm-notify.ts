import type { RpcClient } from "../types.ts";

/**
 * `api.ppm.notify` — tell the person through PPM's own fan-out (push, Telegram, ntfy), under the
 * "Extensions" switch in Settings → Notifications. The title is shown as
 * "<your extension's display name>: <title>"; the body should fit on a lock screen. Answered by
 * `src/services/extension-api/extension-notify-handlers.ts` when the call has ended.
 */

export type PpmNotifyOutcome = "sent" | "off" | "replaced" | "seen";

export interface PpmNotifyRequest {
  /** 1 to 120 characters. */
  title: string;
  /** At most 1,000 characters. */
  body: string;
  /** Opens this chat on tap. Must already exist. */
  sessionId?: string;
  /** Opens this project on tap. Must be a registered project. */
  projectName?: string;
  /** Looked up from `sessionId` when it names a session and this is absent. */
  providerId?: string;
  /** An in-app path instead of a project/session link, such as "/project/p/design/slug". */
  path?: string;
}

export type PpmNotifyErrorCode = "BAD_REQUEST" | "RATE_LIMITED";

/** A refused call. `message` explains why; branch on `code` for "try again later" (`RATE_LIMITED`). */
export class PpmNotifyError extends Error {
  readonly code: PpmNotifyErrorCode;
  constructor(code: PpmNotifyErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "PpmNotifyError";
  }
}

export type PpmNotify = (request: PpmNotifyRequest) => Promise<PpmNotifyOutcome>;

type Wire =
  | { ok: true; result: PpmNotifyOutcome }
  | { ok: false; error: { code: PpmNotifyErrorCode; message: string } };

export function createPpmNotify(rpc: RpcClient, extensionId: string): PpmNotify {
  return async (request) => {
    const wire = await rpc.request<Wire>("notify:send", { ...request, extensionId });
    if (wire.ok) return wire.result;
    throw new PpmNotifyError(wire.error.code, wire.error.message);
  };
}
