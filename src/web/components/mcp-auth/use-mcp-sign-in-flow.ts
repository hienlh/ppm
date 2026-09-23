import { useCallback, useEffect, useRef, useState } from "react";
import {
  startMcpAuth, getMcpAuthFlow, submitMcpAuthCallback, confirmMcpAuth, cancelMcpAuth,
  type McpAuthFlow,
} from "@/lib/api-mcp-auth";
import { useSettingsStore } from "@/stores/settings-store";

const POLL_MS = 2_000;

function isOpen(flow: McpAuthFlow | null): boolean {
  return flow?.status === "waiting" || flow?.status === "completing";
}

/**
 * Drives one MCP sign-in while `serverName` is set: starts the flow, polls it until it
 * settles, and cancels it if the caller goes away first — an abandoned flow would otherwise
 * hold a Claude subprocess open for its full ten minutes.
 */
export function useMcpSignInFlow(
  serverName: string | null,
  project: string | undefined,
  onSignedIn?: (serverName: string) => void,
) {
  const [flow, setFlow] = useState<McpAuthFlow | null>(null);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flowRef = useRef<McpAuthFlow | null>(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
  const reportedRef = useRef<string | null>(null);

  const apply = useCallback((next: McpAuthFlow) => {
    const current = flowRef.current;
    // A poll that left before a submit settled the flow can land after it; an outcome
    // never goes back to "waiting".
    if (current?.id === next.id && !isOpen(current) && isOpen(next)) return;
    flowRef.current = next;
    setFlow(next);
    if (next.status === "done" && reportedRef.current !== next.id) {
      reportedRef.current = next.id;
      // Signed in, so no longer a server the user chose to ignore: if it ever needs a
      // sign-in again, the chat bar should say so.
      useSettingsStore.getState().undismissMcpSignIn(next.serverName);
      onSignedInRef.current?.(next.serverName);
    }
  }, []);

  // Bumped by every start and every teardown, so a start that resolves late — StrictMode
  // runs the opening effect twice, and the server cancels the first flow when the second
  // begins — can neither overwrite the live flow nor outlive the dialog.
  const genRef = useRef(0);

  const start = useCallback(async () => {
    if (!serverName) return;
    const gen = ++genRef.current;
    setStarting(true);
    setError(null);
    setFlow(null);
    flowRef.current = null;
    try {
      const next = await startMcpAuth(serverName, project);
      if (gen !== genRef.current) {
        if (isOpen(next)) void cancelMcpAuth(next.id).catch(() => {});
        return;
      }
      apply(next);
    } catch (e) {
      if (gen === genRef.current) setError((e as Error).message);
    } finally {
      if (gen === genRef.current) setStarting(false);
    }
  }, [serverName, project, apply]);

  // Start when opened; cancel whatever is still open when closed or unmounted.
  useEffect(() => {
    if (!serverName) return;
    void start();
    return () => {
      genRef.current++;
      const open = flowRef.current;
      if (open && isOpen(open)) void cancelMcpAuth(open.id).catch(() => {});
      flowRef.current = null;
    };
  }, [serverName, start]);

  const flowId = flow?.id;
  const polling = isOpen(flow);
  useEffect(() => {
    if (!flowId || !polling) return;
    const timer = setInterval(() => {
      getMcpAuthFlow(flowId).then(apply).catch((e) => {
        // The server no longer knows this flow (restarted, or it was cancelled elsewhere):
        // end it here too, so the dialog offers "Try again" instead of spinning forever.
        const current = flowRef.current;
        if (current?.id === flowId) apply({ ...current, status: "failed", authUrl: undefined, error: (e as Error).message });
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [flowId, polling, apply]);

  const run = useCallback(async (action: (id: string) => Promise<McpAuthFlow>) => {
    const current = flowRef.current;
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      apply(await action(current.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const submitCallback = useCallback((url: string) => run((id) => submitMcpAuthCallback(id, url)), [run]);
  const confirm = useCallback(() => run(confirmMcpAuth), [run]);

  return { flow, starting, busy, error, retry: start, submitCallback, confirm };
}
