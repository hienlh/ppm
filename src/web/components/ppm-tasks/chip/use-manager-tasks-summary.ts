/**
 * Whether a chat shows the Tasks chip, and its counts: only a project's manager chat, and only
 * while that project's task store is on. Every chat tab asks, so nothing is fetched unless the
 * chat is a manager chat (the manager list is already shared and cheap); then the project's
 * counts are read once and again whenever PPM says that project's tasks or settings changed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useManagerChats } from "@/hooks/use-manager-chats";
import { ppmTasksClient } from "@/lib/ppm-tasks/ppm-tasks-client";
import type { TaskProjectSummary } from "../../../../shared/ppm-tasks-api";

const CHANGE_EVENTS = ["tasks:changed", "tasks:project_changed"] as const;

/** The manager chat's project when `sessionId` is a manager chat, else null. */
export function managerProjectOf(
  sessionId: string | null | undefined,
  managers: ReadonlyArray<{ sessionId: string; projectName: string }> | null,
): string | null {
  if (!sessionId || !managers) return null;
  return managers.find((m) => m.sessionId === sessionId)?.projectName ?? null;
}

/** The chip's counts: null when the chip must not show (not a manager chat, or tasks off). */
export function useManagerTasksSummary(sessionId: string | null | undefined): TaskProjectSummary | null {
  const managers = useManagerChats();
  const project = useMemo(() => managerProjectOf(sessionId, managers), [sessionId, managers]);
  const [summary, setSummary] = useState<TaskProjectSummary | null>(null);
  const asked = useRef(0);

  useEffect(() => {
    if (!project) { setSummary(null); return; }
    const load = () => {
      const n = ++asked.current;
      ppmTasksClient.projects()
        // Only the latest read lands, and only for the project still asked about.
        .then((all) => { if (n === asked.current) setSummary(all.find((p) => p.name === project) ?? null); })
        .catch(() => { /* the chip keeps what it showed; it is a summary, not the list */ });
    };
    load();
    const on = (e: Event) => {
      const p = (e as CustomEvent<{ project?: string }>).detail?.project;
      if (!p || p === project) load();
    };
    for (const type of CHANGE_EVENTS) window.addEventListener(type, on);
    return () => { for (const type of CHANGE_EVENTS) window.removeEventListener(type, on); };
  }, [project]);

  return project && summary?.enabled && summary.name === project ? summary : null;
}
