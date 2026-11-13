import type { MetricsSnapshot, MetricsTier } from "../../types/system-metrics.ts";
import { ppmApiRequest } from "../utils/settings-request.ts";
import { serverRequest, serverStream, ServerDownError } from "../utils/ppm-server-client.ts";
import { readSseEvent } from "../utils/sse-first-event.ts";

/**
 * How every `ppm system` command reaches PPM: through the running PPM's Task Manager and Services
 * routes (`/api/system/...`), with their own guards — the kill guard, the service guard, the
 * identity re-check. There is no fallback in this process: the process table and the guards'
 * knowledge of what is PPM's live in the server.
 */
export const SYSTEM_SERVER_ONLY = "The Task Manager and the Services page live in the running PPM.";

/** `/api/system<sub>` on the running PPM. */
export function systemRequest<T>(method: string, sub: string, body?: unknown): Promise<T> {
  return ppmApiRequest<T>(method, `/system${sub}`, body, { serverOnly: SYSTEM_SERVER_ONLY, timeoutMs: 60_000 });
}

/** A full tier's first tick can include starting the Windows collector, which takes seconds. */
const SNAPSHOT_TIMEOUT_MS = 30_000;

/**
 * A metrics snapshot taken after this call, through the stream the Task Manager uses. `n` counts
 * fresh frames: rates (CPU) are measured between two ticks, so a figure that needs them asks for
 * the second — the first after a tier starts has nothing to compare with. The snapshot the server
 * had cached before (answered first on a new stream) never counts: it may be hours old.
 * The stream's session is ended on the server before this returns, whatever happened.
 */
export async function freshSnapshot(tier: MetricsTier, n: 1 | 2): Promise<MetricsSnapshot> {
  const processes = tier === "full" ? 1 : 0;
  const cached = await systemRequest<MetricsSnapshot | null>("GET", `/resources?processes=${processes}`);
  const cachedTs = cached?.ts ?? Number.NEGATIVE_INFINITY;
  const abort = new AbortController();
  try {
    let res: Response;
    try {
      res = await serverStream(`/system/resources/stream?processes=${processes}`, abort.signal);
    } catch (e) {
      if (e instanceof ServerDownError) throw new Error(`${SYSTEM_SERVER_ONLY} Start PPM (\`ppm start\`) and run this again.`);
      throw e;
    }
    if (!res.ok) {
      const json = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(json?.error ?? `HTTP ${res.status}`);
    }
    return await readSseEvent<MetricsSnapshot>(res, "snapshot", n, SNAPSHOT_TIMEOUT_MS, {
      accept: (s) => s.ts > cachedTs,
      release: async (sid) => { await serverRequest("DELETE", `/system/resources/stream/${encodeURIComponent(sid)}`); },
    });
  } finally {
    abort.abort();
  }
}
