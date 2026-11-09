/**
 * The moment a session's tool has finished changing a file — a file tool's PostToolUse, a shell
 * command's `git status` bracket, a codex patch — announced by `observeFile`'s "after", which
 * every one of those goes through. Its own module so the history can announce it without
 * reaching the list that listens (`session-file-changes.service.ts`), which reads the history.
 */
type FileWrittenListener = (sessionId: string, path: string) => void;

const listeners = new Set<FileWrittenListener>();

/** Subscribe; returns the unsubscribe function. */
export function onSessionFileWritten(cb: FileWrittenListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function sessionFileWritten(sessionId: string, path: string): void {
  for (const cb of listeners) {
    // A failing listener must not turn a write the agent made into an error.
    try {
      cb(sessionId, path);
    } catch (e) {
      console.warn(`[session-baselines] file-written listener failed: ${(e as Error).message}`);
    }
  }
}
