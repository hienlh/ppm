import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Whether a Claude background task's output file was written after a moment: the one sign, after a
 * restart, that the work is still running. The CLI keeps each task's output at
 * `<claude temp>/<folder>/<session id>/tasks/<task id>.output`, where `<claude temp>` is
 * `%TEMP%\claude` on Windows and `/tmp/claude-<uid>` elsewhere, and `<folder>` is named by the CLI
 * (the project's path once, a hash now), so every folder under each base is tried.
 *
 * A shell PPM ran it in ends with the server, but a process it left behind still holding the file
 * (a detached job, `docker logs -f`) keeps writing, and so does a command in a systemd unit of its
 * own. A file not written since proves nothing either way: quiet work writes nothing.
 */

const ID_RE = /^[\w.-]{1,200}$/;

export type TaskOutputProbe = (sessionId: string, taskId: string, since: number) => boolean;

/** Where the Claude CLI may keep its task files on this machine. */
export function claudeTaskBases(): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const bases = [join(tmpdir(), "claude")];
  if (uid !== null) bases.push(join(tmpdir(), `claude-${uid}`), `/tmp/claude-${uid}`);
  return [...new Set(bases)];
}

/**
 * A probe answering, for one task, whether its output file was modified after `since`. Each base is
 * listed once and each session's folders found once per probe, so a probe built once per scan or
 * re-check costs one listing however many tasks it is asked about. On a POSIX system a base another
 * user owns is skipped: anyone can create `/tmp/claude`, and a file there must not make work look alive.
 */
export function taskOutputProbe(bases: readonly string[] = claudeTaskBases()): TaskOutputProbe {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let folders: Array<{ base: string; folder: string }> | null = null;
  const allFolders = () => {
    if (folders) return folders;
    folders = [];
    for (const base of bases) {
      try {
        if (uid !== null && statSync(base).uid !== uid) continue;
        for (const folder of readdirSync(base)) folders.push({ base, folder });
      } catch { /* no such base */ }
    }
    return folders;
  };
  const sessionDirs = new Map<string, string[]>();
  const dirsOf = (sessionId: string): string[] => {
    let dirs = sessionDirs.get(sessionId);
    if (!dirs) {
      dirs = [];
      for (const { base, folder } of allFolders()) {
        const dir = join(base, folder, sessionId, "tasks");
        try { if (statSync(dir).isDirectory()) dirs.push(dir); } catch { /* not this folder */ }
      }
      sessionDirs.set(sessionId, dirs);
    }
    return dirs;
  };
  return (sessionId, taskId, since) => {
    // Both ids come from the trace: anything that could step out of the folder is not a task of ours.
    if (!ID_RE.test(sessionId) || !ID_RE.test(taskId) || sessionId.startsWith(".") || taskId.startsWith(".")) return false;
    return dirsOf(sessionId).some((dir) => {
      try { return statSync(join(dir, `${taskId}.output`)).mtimeMs > since; } catch { return false; }
    });
  };
}
