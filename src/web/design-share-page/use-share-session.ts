import { useCallback, useMemo, useRef, useState } from "react";
import type { DesignShareGuestInfo } from "../../shared/design-share-guest-types";
import { failureMessage, isVersionChanged, ShareApiError, shareWrites, type ShareFailure } from "./share-api";
import { browserStore, loadGuestKey, loadGuestName, saveGuestName } from "./share-identity";
import { useShareThreads } from "./use-share-threads";
import type { GuestThread } from "./share-thread-model";

/**
 * One reviewer on one link: their key and name, the threads, and every write, each of
 * which reports its own failure in the page's notice line and answers whether it went
 * through. A write refused because the link stopped opening turns the whole page into the
 * "no longer valid" state, the same as a poll that finds it so.
 */

export interface ShareNotice { id: number; message: string }

export function useShareSession(info: DesignShareGuestInfo, code: string) {
  const store = useMemo(() => browserStore(), []);
  const key = useMemo(() => loadGuestKey(store, info.linkId), [store, info.linkId]);
  const [name, setNameState] = useState(() => loadGuestName(store, info.linkId));
  const [notice, setNotice] = useState<ShareNotice | null>(null);
  const [writeInvalid, setWriteInvalid] = useState(false);
  const noticeId = useRef(0);

  const notify = useCallback((message: string) => setNotice({ id: ++noticeId.current, message }), []);
  const dismissNotice = useCallback(() => setNotice(null), []);
  const onPollFailure = useCallback((f: ShareFailure) => notify(failureMessage(f)), [notify]);
  const threads = useShareThreads(code, key, info.versionId, onPollFailure);
  const [writeVersionChanged, setWriteVersionChanged] = useState(false);
  const { applyThread, applyDeleted, refresh } = threads;
  const writes = useMemo(() => shareWrites(code, key), [code, key]);

  /** Validates and remembers a name; an error is for the field that asked. */
  const setName = useCallback((raw: string) => {
    const saved = saveGuestName(store, info.linkId, raw);
    if (saved.ok) setNameState(saved.name);
    return saved;
  }, [store, info.linkId]);

  const run = useCallback(async <T,>(op: () => Promise<T>, done: (result: T) => void): Promise<boolean> => {
    try {
      done(await op());
      return true;
    } catch (e) {
      const failure: ShareFailure = e instanceof ShareApiError ? e.failure : { kind: "network" };
      if (failure.kind === "invalid") setWriteInvalid(true);
      // The page's own bar says this, with the button that fixes it.
      else if (isVersionChanged(failure)) setWriteVersionChanged(true);
      else notify(failureMessage(failure));
      // The thread may be gone or changed under the reviewer; show what is there now.
      if (failure.kind === "error" && (failure.status === 404 || failure.status === 409)) refresh();
      return false;
    }
  }, [notify, refresh]);

  const actions = useMemo(() => ({
    addThread: (anchor: unknown, body: string, as: string, onDone: (t: GuestThread) => void) =>
      run(() => writes.addThread(anchor, body, as, info.versionId), (t) => { applyThread(t); onDone(t); }),
    reply: (id: string, body: string, as: string) => run(() => writes.reply(id, body, as), applyThread),
    editThread: (id: string, body: string) => run(() => writes.editThread(id, body), applyThread),
    deleteThread: (id: string) => run(() => writes.deleteThread(id), () => applyDeleted(id)),
    editReply: (id: string, replyId: string, body: string) => run(() => writes.editReply(id, replyId, body), applyThread),
    deleteReply: (id: string, replyId: string) => run(() => writes.deleteReply(id, replyId), applyThread),
  }), [run, writes, applyThread, applyDeleted, info.versionId]);

  return {
    name, setName, notice, dismissNotice,
    threads: threads.threads, loaded: threads.loaded, invalid: threads.invalid || writeInvalid,
    versionChanged: threads.versionChanged || writeVersionChanged,
    actions,
  };
}

export type ShareSession = ReturnType<typeof useShareSession>;
export type ShareActions = ShareSession["actions"];
