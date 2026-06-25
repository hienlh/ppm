/**
 * BackgroundShellRegistry — tracks SDK background commands (Bash run_in_background)
 * per chat session so the frontend can show a live bar + open their .output files.
 *
 * Entries are retained (status flips to "stopped") for the session lifetime so a
 * just-stopped command's .output pill still resolves; cleared only on disconnect.
 */

import type { BackgroundShell } from "../types/api.ts";

/** sessionId → (shellId → BackgroundShell) */
const registry = new Map<string, Map<string, BackgroundShell>>();

function sessionMap(sessionId: string): Map<string, BackgroundShell> {
  let m = registry.get(sessionId);
  if (!m) {
    m = new Map();
    registry.set(sessionId, m);
  }
  return m;
}

/** Register (or update) a background shell. shellId defaults to the .output basename. */
function register(
  sessionId: string,
  shell: Omit<BackgroundShell, "status" | "startedAt"> & Partial<Pick<BackgroundShell, "status" | "startedAt">>,
): void {
  const m = sessionMap(sessionId);
  const existing = m.get(shell.shellId);
  m.set(shell.shellId, {
    status: shell.status ?? existing?.status ?? "running",
    startedAt: shell.startedAt ?? existing?.startedAt ?? Date.now(),
    shellId: shell.shellId,
    command: shell.command || existing?.command || "",
    outputPath: shell.outputPath || existing?.outputPath || "",
    toolUseId: shell.toolUseId || existing?.toolUseId || "",
  });
}

function setStatus(sessionId: string, shellId: string, status: BackgroundShell["status"]): boolean {
  const entry = registry.get(sessionId)?.get(shellId);
  if (!entry) return false;
  entry.status = status;
  return true;
}

/** Mark every running shell of a session as stopped (e.g. turn ended unexpectedly). */
function markAllStopped(sessionId: string): void {
  const m = registry.get(sessionId);
  if (!m) return;
  for (const entry of m.values()) {
    if (entry.status !== "stopped") entry.status = "stopped";
  }
}

function list(sessionId: string): BackgroundShell[] {
  return Array.from(registry.get(sessionId)?.values() ?? []);
}

function get(sessionId: string, shellId: string): BackgroundShell | undefined {
  return registry.get(sessionId)?.get(shellId);
}

function clearSession(sessionId: string): void {
  registry.delete(sessionId);
}

export const backgroundShellRegistry = {
  register,
  setStatus,
  markAllStopped,
  list,
  get,
  clearSession,
};
