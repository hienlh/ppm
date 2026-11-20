/**
 * Asks the server where the OS file browser should open for a path (`POST /api/fs/locate`), and
 * opens it there.
 *
 * Two callers with different needs share this. A finished AI answer asks for every path it names
 * before drawing any of them as links: those asks are queued for one tick and sent as one request,
 * and the answers are kept for a few minutes, so a message costs one round trip and a re-render
 * costs none. A tap (a link, a `/files` address, the path field) asks again with no cache, since
 * the disk may have changed since the link was drawn.
 */

import { create } from "zustand";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { openExplorer } from "@/components/os-explorer/open-explorer";
import {
  MAX_LOCATE_PATHS, type FileBrowserLocateEntry, type FileBrowserLocateResponse,
} from "../../shared/file-browser-target";

/** How long an answer is trusted for drawing a link. */
const VERDICT_TTL_MS = 5 * 60_000;
/** How long asks wait to be sent together. */
const BATCH_DELAY_MS = 30;

const keyOf = (project: string | undefined, path: string) => `${project ?? ""}\u0000${path}`;

interface VerdictStore {
  verdicts: Record<string, { entry: FileBrowserLocateEntry; at: number }>;
}

/** The answers drawn links read; one subscription per link, keyed by project and path. */
export const useLocateVerdicts = create<VerdictStore>(() => ({ verdicts: {} }));

const queued = new Map<string, { project: string | undefined; path: string }>();
const inFlight = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Send `paths` for one project, at most `MAX_LOCATE_PATHS` a request. */
export async function locatePaths(paths: string[], project?: string): Promise<FileBrowserLocateEntry[]> {
  const results: FileBrowserLocateEntry[] = [];
  for (let i = 0; i < paths.length; i += MAX_LOCATE_PATHS) {
    const chunk = paths.slice(i, i + MAX_LOCATE_PATHS);
    const answer = await api.post<FileBrowserLocateResponse>("/api/fs/locate", project ? { paths: chunk, project } : { paths: chunk });
    results.push(...answer.results);
  }
  return results;
}

async function flush(): Promise<void> {
  timer = null;
  const byProject = new Map<string | undefined, string[]>();
  for (const [key, { project, path }] of queued) {
    inFlight.add(key);
    byProject.set(project, [...(byProject.get(project) ?? []), path]);
  }
  queued.clear();
  for (const [project, paths] of byProject) {
    try {
      const results = await locatePaths(paths, project);
      const at = Date.now();
      useLocateVerdicts.setState((s) => {
        // Answers past their time are dropped here, so a long session does not keep every path
        // it ever rendered; a link still on screen asks again on its next render.
        const verdicts = Object.fromEntries(Object.entries(s.verdicts).filter(([, v]) => at - v.at < VERDICT_TTL_MS));
        for (const entry of results) verdicts[keyOf(project, entry.input)] = { entry, at };
        return { verdicts };
      });
    } catch {
      // No answer means no link: the path stays plain text, and a later render may ask again.
    } finally {
      for (const path of paths) inFlight.delete(keyOf(project, path));
    }
  }
}

/** Queue `path` to be checked unless a fresh answer is already held or on its way. */
export function requestVerdict(path: string, project?: string): void {
  const key = keyOf(project, path);
  const held = useLocateVerdicts.getState().verdicts[key];
  if ((held && Date.now() - held.at < VERDICT_TTL_MS) || inFlight.has(key) || queued.has(key)) return;
  queued.set(key, { project, path });
  timer ??= setTimeout(() => void flush(), BATCH_DELAY_MS);
}

/** The held answer for `path`, or undefined while none is. */
export function useVerdict(path: string | null, project?: string): FileBrowserLocateEntry | undefined {
  return useLocateVerdicts((s) => (path ? s.verdicts[keyOf(project, path)]?.entry : undefined));
}

/** Forget every held answer (tests). */
export function resetLocateVerdicts(): void {
  queued.clear();
  inFlight.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  useLocateVerdicts.setState({ verdicts: {} });
}

/**
 * Open the file browser at `path` (a folder, or a file's folder with the file selected), after
 * the server has checked it. Returns the error shown, or null when the browser opened.
 */
export async function openFileBrowserAt(path: string, project?: string): Promise<string | null> {
  let entry: FileBrowserLocateEntry | undefined;
  try {
    [entry] = await locatePaths([path], project);
  } catch (e) {
    const message = e instanceof Error ? e.message : "PPM could not check that path.";
    toast.error(message);
    return message;
  }
  if (!entry || !entry.ok) {
    const message = entry && !entry.ok ? entry.error : `PPM could not open ${path}.`;
    toast.error(message);
    return message;
  }
  await openExplorer(entry.dir, { select: entry.select });
  return null;
}
