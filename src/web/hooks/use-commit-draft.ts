/**
 * The shared commit message of the project's current repository: what
 * `commit-draft-store.ts` holds, kept in step with changes made elsewhere.
 */
import { useCallback, useEffect } from "react";
import { useGitRepo } from "@/hooks/use-git-repo";
import { COMMIT_DRAFT_CLIENT_ID, useCommitDraftStore } from "@/stores/commit-draft-store";
import type { CommitDraftEvent } from "../../shared/git-changes";

export interface UseCommitDraft {
  message: string;
  loaded: boolean;
  setMessage: (message: string) => void;
  /** Save what was typed and wait for it: call before committing with it. */
  flush: () => Promise<void>;
  /** Call once a commit used the message, with the text it committed. */
  consumed: (committed: string) => void;
  /** Read it again, unless an edit here is unsaved (e.g. after Undo last commit put a message back). */
  reload: () => Promise<void>;
}

export function useCommitDraft(projectName: string | undefined): UseCommitDraft {
  const gitRepo = useGitRepo(projectName);
  const usable = !!projectName && !gitRepo.needsPick && !gitRepo.noRepo;
  const url = usable ? gitRepo.gitUrl("/commit-draft") : null;
  const entry = useCommitDraftStore((s) => (url ? s.drafts[url] : undefined));

  useEffect(() => {
    if (url) void useCommitDraftStore.getState().load(url);
  }, [url]);

  useEffect(() => {
    if (!url) return;
    const onDraft = (e: Event) => {
      const event = (e as CustomEvent<CommitDraftEvent>).detail;
      // Which repository it was is not compared here: the server's path and
      // this page's can be two spellings of one directory, and a re-read is cheap.
      if (event.projectName !== projectName || event.clientId === COMMIT_DRAFT_CLIENT_ID) return;
      void useCommitDraftStore.getState().refresh(url);
    };
    window.addEventListener("git:commit-draft", onDraft);
    return () => window.removeEventListener("git:commit-draft", onDraft);
  }, [url, projectName]);

  const setMessage = useCallback((message: string) => {
    if (url) useCommitDraftStore.getState().edit(url, message);
  }, [url]);
  const flush = useCallback(async () => {
    if (url) await useCommitDraftStore.getState().flush(url);
  }, [url]);
  const consumed = useCallback((committed: string) => {
    if (url) useCommitDraftStore.getState().consumed(url, committed);
  }, [url]);
  const reload = useCallback(async () => {
    if (url) await useCommitDraftStore.getState().refresh(url);
  }, [url]);

  return { message: entry?.message ?? "", loaded: entry?.loaded ?? false, setMessage, flush, consumed, reload };
}
