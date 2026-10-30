import { useEffect, useState } from "react";
import { api, projectUrl } from "@/lib/api-client";
import type { EffortStatus } from "../../shared/effort-status";

/** Short-lived: it is read from settings files the user may be editing right now. */
const CACHE_MS = 30_000;
const cache = new Map<string, { status: EffortStatus | null; at: number }>();

/**
 * What overrides the effort pick outside PPM. A session's own status comes over its socket once
 * the server has sent it; a chat with no session yet — the new-chat composer — asks what the
 * project's settings files say, so the chip is right before the first message too.
 */
export function useEffortStatus(p: {
  projectName?: string;
  providerId?: string;
  model?: string | null;
  sessionStatus: EffortStatus | null | undefined;
}): EffortStatus | null {
  const { projectName, providerId, model, sessionStatus } = p;
  const key = JSON.stringify([projectName ?? null, providerId ?? null, model ?? null]);
  const wanted = sessionStatus === undefined && !!projectName && !!providerId;
  const [fetched, setFetched] = useState<{ key: string; status: EffortStatus | null } | null>(null);

  useEffect(() => {
    if (!wanted) return;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      setFetched({ key, status: hit.status });
      return;
    }
    let active = true;
    const query = model ? `?model=${encodeURIComponent(model)}` : "";
    api.get<{ status: EffortStatus | null }>(`${projectUrl(projectName!)}/chat/providers/${providerId}/effort-status${query}`)
      .then(({ status }) => {
        cache.set(key, { status, at: Date.now() });
        if (active) setFetched({ key, status });
      })
      // Nothing to say then; the chip shows the pick as it always did.
      .catch(() => {});
    return () => { active = false; };
  }, [wanted, key, projectName, providerId, model]);

  if (sessionStatus !== undefined) return sessionStatus;
  return fetched?.key === key ? fetched.status : cache.get(key)?.status ?? null;
}
