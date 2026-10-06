/** What one push carries from `web-push.service.ts` to the service worker (`src/web/sw.ts`). */
export interface WebPushPayload {
  title: string;
  body: string;
  /** Absolute. The worker hands it to an open PPM window when that window is on this URL's origin. */
  url: string;
  /** Same tag = the newer notification replaces the older one on the device. */
  tag: string;
  /** Project name, "" when there is none. */
  project: string;
  /** "" when the event belongs to no session. */
  sessionId: string;
  /** The session's provider; "" when unknown. */
  providerId: string;
}

/** Posted by the service worker to an open PPM window when one of its notifications is clicked. */
export const OPEN_FROM_NOTIFICATION = "ppm:open-from-notification";

export interface OpenFromNotificationMessage {
  type: typeof OPEN_FROM_NOTIFICATION;
  url: string;
  project: string;
  sessionId: string;
  providerId: string;
}

/** A push body is the server's, but the worker still reads it as untrusted JSON. */
export function readWebPushPayload(raw: unknown): WebPushPayload {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    title: str(o.title) || "PPM",
    body: str(o.body),
    url: str(o.url) || "/",
    tag: str(o.tag),
    project: str(o.project),
    sessionId: str(o.sessionId),
    providerId: str(o.providerId),
  };
}
