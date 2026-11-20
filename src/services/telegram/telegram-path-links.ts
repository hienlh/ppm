import { projectService } from "../project.service.ts";
import { notificationLink } from "../notification-link.ts";
import { fileBrowserScope, resolveFileBrowserTarget } from "../file-browser-target.ts";
import { fileBrowserLink } from "../../shared/file-browser-target.ts";
import { findPathsInText, inlineCodePath } from "../../web/lib/local-path-detect.ts";
import { pathLinkCache, PATH_LINK_TTL_MS } from "./telegram-path-link-cache.ts";

/**
 * Folder and file paths in a Telegram message (an Assistant answer, a manager's card) as links
 * that open PPM's file browser there (`/files?path=…`).
 *
 * The Markdown-to-Telegram formatter is synchronous and runs in many places, while deciding
 * whether a path may be a link means asking the disk. So a sender calls `primeTelegramPathLinks`
 * with the Markdown just before formatting, which checks every absolute path in it under the same
 * rules as the Assistant's `ui_open_file_browser` (missing, PPM's own folder and stores of logins
 * and keys are not linked) and keeps the answer for a few minutes; the formatter then reads
 * `telegramPathLink`, which only ever answers from that cache. A message formatted without being
 * primed simply has no path links. The cache itself is `telegram-path-link-cache.ts`, kept apart
 * so the formatter does not load the project list, the tunnel or the disk rules.
 *
 * Only absolute paths (`C:\…`, `~/…`, `/…`): a Telegram message has no project to resolve a
 * relative one against. Links go to PPM's public address when there is one (tunnel, Tailscale
 * Service), else localhost, as every other Telegram link does.
 */

const MAX_PATHS_PER_MESSAGE = 40;

const isAbsolutePath = (p: string) => /^(?:[A-Za-z]:[\\/]|~[\\/]|\/)/.test(p);

/** The absolute paths `md` names, in prose and in inline code, at most `MAX_PATHS_PER_MESSAGE`. */
export function telegramPathCandidates(md: string): string[] {
  const found = new Set<string>();
  for (const code of md.matchAll(/`([^`\n]+)`/g)) {
    const quoted = inlineCodePath(code[1]!);
    if (quoted && isAbsolutePath(quoted.path)) found.add(quoted.path);
  }
  for (const hit of findPathsInText(md.replace(/`[^`\n]+`/g, " "))) {
    if (isAbsolutePath(hit.path)) found.add(hit.path);
  }
  return [...found].slice(0, MAX_PATHS_PER_MESSAGE);
}

/** PPM's address as Telegram links name it. */
async function linkBase(): Promise<string | null> {
  const home = await notificationLink({ project: "", sessionId: "" }).catch(() => null);
  return home ? new URL(home).origin : null;
}

/** Check every absolute path in `md` and remember which ones may be links. Never throws. */
export async function primeTelegramPathLinks(md: string): Promise<void> {
  try {
    const now = Date.now();
    const fresh = (p: string) => { const c = pathLinkCache.get(p); return c && now - c.at < PATH_LINK_TTL_MS; };
    const paths = telegramPathCandidates(md).filter((p) => !fresh(p));
    if (paths.length === 0) return;
    const base = await linkBase();
    if (!base) return;
    const scope = fileBrowserScope(projectService.list().map((p) => p.path));
    for (const path of paths) {
      const outcome = await resolveFileBrowserTarget(path, { scope });
      pathLinkCache.set(path, outcome.ok ? fileBrowserLink(base, path) : null, now);
    }
  } catch {
    // No links is the safe answer: the message still goes out as text.
  }
}
