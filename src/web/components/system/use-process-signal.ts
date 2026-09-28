/**
 * Sending one signal to a process — Mission Center's "Send Signal" submenu.
 *
 * Separate from `useProcessKill` because the two mean different things: a kill
 * escalates TERM to KILL, while asking for SIGSTOP must send SIGSTOP and nothing
 * else. The server enforces the SAME guard for both, so a process the kill button
 * refuses cannot be suspended either.
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { getAuthToken } from "@/lib/api-client";
import type {
  ProcessInfo, ProcessSignal, SignalProcessRequest, SignalProcessResult,
} from "../../../types/system-metrics";

/** Human wording for the menu, in the order Mission Center lists them. */
export const SIGNAL_LABELS: Record<ProcessSignal, string> = {
  STOP: "Suspend (SIGSTOP)",
  CONT: "Continue (SIGCONT)",
  TERM: "Terminate (SIGTERM)",
  KILL: "Kill (SIGKILL)",
  HUP: "Hang up (SIGHUP)",
  INT: "Interrupt (SIGINT)",
  USR1: "User signal 1",
  USR2: "User signal 2",
};

/** The two that cannot be caught or ignored, so the UI can warn before sending. */
export const UNCATCHABLE_SIGNALS: readonly ProcessSignal[] = ["KILL", "STOP"];

/** `api.post` has no way to add the `X-PPM-Request` header the route requires,
 *  so this mirrors `killProcess` exactly — one Error on any failure. */
export async function signalProcess(request: SignalProcessRequest): Promise<SignalProcessResult> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-PPM-Request": "1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch("/api/system/resources/signal", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  let json: { ok: boolean; data?: SignalProcessResult; error?: string };
  try {
    json = await res.json();
  } catch {
    throw new Error(res.ok ? "Empty response from server" : `Server error (HTTP ${res.status})`);
  }
  if (json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.data as SignalProcessResult;
}

export function buildSignalRequest(
  proc: ProcessInfo,
  signal: ProcessSignal,
  tree: boolean,
): SignalProcessRequest {
  // `startedAt` is the identity guard: a recycled pid is a 409, never a signal
  // delivered to whatever took the number over.
  return { pid: proc.pid, startedAt: proc.startedAt, signal, tree };
}

export function useProcessSignal() {
  const [pending, setPending] = useState<number | null>(null);

  const send = useCallback(async (proc: ProcessInfo, signal: ProcessSignal, tree = false) => {
    setPending(proc.pid);
    try {
      const result = await signalProcess(buildSignalRequest(proc, signal, tree));
      const count = result.signalled.length;
      toast.success(
        count > 1
          ? `Sent SIG${signal} to ${proc.name} and ${count - 1} child processes`
          : `Sent SIG${signal} to ${proc.name} (${proc.pid})`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not signal ${proc.name}`);
    } finally {
      setPending(null);
    }
  }, []);

  return { send, pending };
}
