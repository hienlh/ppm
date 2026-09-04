import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { getAuthToken } from "@/lib/api-client";
import { buildGroupKillRequests, buildKillRequest, isGroupProtected, type KillTarget } from "./build-kill-request";
import type {
  KillProcessRequest,
  KillProcessResult,
  MetricsSnapshot,
  ProcessGroup,
  ProcessInfo,
} from "../../../types/system-metrics";

/** `api.post` (src/web/lib/api-client.ts) has no way to add a bespoke header, and the
 *  kill route requires `X-PPM-Request: 1` — CSRF hardening, since a cross-origin HTML
 *  form cannot set a custom header, so a preflight becomes mandatory. A raw fetch here
 *  mirrors `handleResponse`'s single-Error-on-any-failure contract exactly, so the
 *  caller still has exactly one catch path. */
export async function killProcess(request: KillProcessRequest): Promise<KillProcessResult> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-PPM-Request": "1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch("/api/system/resources/kill", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });

  let json: { ok: boolean; data?: KillProcessResult; error?: string };
  try {
    json = await res.json();
  } catch {
    throw new Error(res.ok ? "Empty response from server" : `Server error (HTTP ${res.status})`);
  }
  if (json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.data as KillProcessResult;
}

/**
 * Pending-kill state plus the confirm handler for single processes and whole app
 * groups. Members are resolved against the CURRENT snapshot at click time, so a
 * helper that exited since the row was drawn is simply not in the list.
 */
export function useProcessKill(snapshot: MetricsSnapshot) {
  const [pendingKill, setPendingKill] = useState<KillTarget | null>(null);

  const membersOf = useCallback(
    (group: ProcessGroup): ProcessInfo[] => {
      const byPid = new Map(snapshot.processes.map((p) => [p.pid, p]));
      return group.pids.map((pid) => byPid.get(pid)).filter((p): p is ProcessInfo => !!p);
    },
    [snapshot.processes],
  );

  /** group key → true when any member is refused by the guard (button disabled). */
  const groupProtected = useMemo(
    () => new Map(snapshot.groups.map((g) => [g.key, isGroupProtected(membersOf(g))])),
    [snapshot.groups, membersOf],
  );

  const requestKillProcess = useCallback((proc: ProcessInfo) => setPendingKill({ kind: "process", proc }), []);
  const requestKillGroup = useCallback(
    (group: ProcessGroup) => setPendingKill({ kind: "group", group, members: membersOf(group) }),
    [membersOf],
  );
  const cancelKill = useCallback(() => setPendingKill(null), []);

  const confirmKill = useCallback(async (target: KillTarget, tree: boolean) => {
    setPendingKill(null);
    if (target.kind === "process") {
      const { proc } = target;
      try {
        await killProcess(buildKillRequest(proc, tree));
        toast.success(`Ended ${proc.name} (${proc.pid})`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : `Failed to end ${proc.name}`);
      }
      return;
    }
    // Whole app: one tree kill on the root when it exists, else one per member.
    // Requests run sequentially so the guard's 403/409 for one member is reported,
    // not lost in a Promise.all rejection.
    const { group, members } = target;
    const failures: string[] = [];
    for (const req of buildGroupKillRequests(group, members)) {
      try {
        await killProcess(req);
      } catch (e) {
        failures.push(e instanceof Error ? e.message : `pid ${req.pid}`);
      }
    }
    if (failures.length === 0) toast.success(`Ended ${group.label} (${members.length} processes)`);
    else toast.error(`${group.label}: ${failures.length} of ${members.length} could not be ended — ${failures[0]}`);
  }, []);

  return { pendingKill, groupProtected, requestKillProcess, requestKillGroup, confirmKill, cancelKill };
}
