/**
 * The Review tab's state: every file the session changed with its blocks, the block in focus and
 * its file's diff, and every answer — keep, revert, open again, undo — shown at once and sent to
 * the server one at a time.
 *
 * Four things are easy to get wrong:
 *
 * - The tab must work without its chat. After a reload the chat tab may never have mounted, so
 *   the list is fetched here too, with the transcript's paths the bar wrote into the metadata.
 *   While the chat is open, the bar's refreshes arrive as `SESSION_CHANGES_EVENT`. Any list asked
 *   for before the last answer landed is dropped: it would bring answered blocks back.
 * - Every answer names the version of the file it was drawn at, and the server refuses one that
 *   moved on. A revert moves it, so a second answer on the same file, drawn before the first
 *   landed, is sent with the version the first one left (`versionAfter`) — never with a version
 *   the agent made, which nobody has read. Answers go out one at a time for the same reason.
 * - A reverted block is no longer a change and drops out of the server's list; the tab keeps it
 *   (`reverted`, and `gone` for a file with nothing left) to show it in place, and lets it go
 *   once the agent writes over its lines (`PaneModel.stale`).
 * - Answers are drawn against the diff on screen, not the list: the list may already be newer
 *   while the diff is still on its way.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { changeKey } from "@/lib/session-file-changes";
import {
  SESSION_CHANGES_EVENT,
  announceReviewMarks,
  answerSessionChanges,
  fetchSessionFileChanges,
  fetchSessionFileDiff,
  undoSessionAnswer,
  type SessionChangesEventDetail,
} from "@/lib/session-file-changes-client";
import {
  WHOLE_FILE,
  answerKey,
  fileReviews,
  firstInFile,
  nextOpen,
  paneModel,
  reviewProgress,
  stepBlock,
  type BlockState,
  type FileReview,
  type Focus,
  type PaneItem,
  type PaneModel,
  type RevertedBlock,
  type RevertedFile,
} from "@/lib/session-review-model";
import type { SessionAnswer, SessionFileAnswer, SessionFileChange, SessionFileDiff } from "../../shared/session-file-changes";

/** How long an answer's Undo stays on screen. */
const TOAST_MS = 5000;

export interface ReviewToast {
  id: number;
  /** "Kept block 2 of", then the file's name in bold, then the rest. */
  lead: string;
  name?: string;
  tail?: string;
  undoId?: string;
  /** Where focus goes back to when the answer is undone. */
  focus?: Focus | null;
}

type BlockItem = Extract<PaneItem, { kind: "block" }>;

/** The file in focus as the pane draws it. */
export type ReviewPane =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  /** No blocks to step through: binary, too large, or too slow to cut. `undoId` names a revert that took it whole. */
  | { kind: "whole"; review: FileReview; undoId?: string }
  | {
      kind: "blocks";
      review: FileReview;
      model: PaneModel;
      /** The version the blocks were drawn at: what an answer about them names. */
      version: string;
      /** What the blocks were cut against, and its name. */
      original: string;
      base: string;
    };

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

function ghostOf(item: BlockItem, pane: Extract<ReviewPane, { kind: "blocks" }>): RevertedBlock {
  return {
    key: item.key,
    rows: item.rows,
    oldFrom: item.oldFrom,
    oldTo: item.oldTo,
    added: item.added,
    removed: item.removed,
    base: pane.base,
    drawnVersion: pane.version,
    ...(item.calls ? { calls: item.calls } : {}),
  };
}

interface Target {
  review: FileReview;
  drawn: string;
  keys?: string[];
  /** The text a file reverted whole goes back to, to keep drawing it once it is no longer listed. */
  text?: string | null;
}

export function useSessionReview(p: {
  projectName?: string;
  sessionId?: string;
  /** The transcript's paths, which cover a session older than the server's own copies. */
  paths: string[];
  /** Asked for from the changes bar: a fresh object each time. */
  select?: { path?: string; at?: number };
}) {
  const { projectName, sessionId } = p;
  const [files, setFiles] = useState<SessionFileChange[] | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [reverted, setReverted] = useState<ReadonlyMap<string, RevertedBlock[]>>(new Map());
  const [gone, setGone] = useState<ReadonlyMap<string, RevertedFile>>(new Map());
  const [pending, setPending] = useState<ReadonlyMap<string, BlockState>>(new Map());
  const [focus, setFocus] = useState<Focus | null>(null);
  const [diff, setDiff] = useState<SessionFileDiff | null>(null);
  const [diffError, setDiffError] = useState<{ key: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ReviewToast | null>(null);

  const answering = useRef(0);
  const lastAnswerAt = useRef(-1);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const versionAfter = useRef(new Map<string, Map<string, string>>());
  const livePaths = useRef<string[]>([]);
  const pathsRef = useRef<string[]>([]);
  pathsRef.current = [...new Set([...p.paths, ...livePaths.current])];

  /** Take a list asked for at `askedAt`, unless an answer landed or is on its way since. */
  const takeList = useCallback((next: SessionFileChange[], askedAt: number) => {
    if (answering.current > 0 || askedAt < lastAnswerAt.current) return;
    setFiles(next);
    setOrder((prev) => {
      const known = new Set(prev);
      const added = next.map((f) => f.path).filter((path) => !known.has(path));
      return added.length ? [...prev, ...added] : prev;
    });
  }, []);

  const listRequest = useRef<AbortController | null>(null);
  const loadList = useCallback(async () => {
    if (!projectName || !sessionId) return;
    listRequest.current?.abort();
    const request = new AbortController();
    listRequest.current = request;
    const askedAt = performance.now();
    setLoading(true);
    setError(null);
    try {
      const next = await fetchSessionFileChanges(projectName, sessionId, pathsRef.current, request.signal);
      if (!request.signal.aborted) takeList(next, askedAt);
    } catch (e) {
      if (!request.signal.aborted) setError(e instanceof Error ? e.message : "Could not list this chat's changes");
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [projectName, sessionId, takeList]);

  useEffect(() => {
    void loadList();
    return () => listRequest.current?.abort();
  }, [loadList]);

  useEffect(() => {
    const onChanges = (e: Event) => {
      const detail = (e as CustomEvent<SessionChangesEventDetail>).detail;
      if (detail.projectName !== projectName || detail.sessionId !== sessionId) return;
      livePaths.current = detail.paths;
      takeList(detail.files, detail.askedAt);
    };
    window.addEventListener(SESSION_CHANGES_EVENT, onChanges);
    return () => window.removeEventListener(SESSION_CHANGES_EVENT, onChanges);
  }, [projectName, sessionId, takeList]);

  const reviews = useMemo(
    () => fileReviews({ order, files: files ?? [], reverted, gone, pending }),
    [order, files, reverted, gone, pending],
  );
  const progress = useMemo(() => reviewProgress(reviews), [reviews]);
  const focused = focus ? reviews.find((r) => r.path === focus.path) ?? null : null;

  // The changes bar asks for a file by writing a fresh `select`; otherwise focus stays on its
  // block while it is there, and a block the agent rewrote hands focus to its file.
  const selectAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!files) return;
    const wanted = p.select?.path && p.select.at !== selectAt.current ? p.select : null;
    if (wanted) {
      selectAt.current = wanted.at;
      const review = reviews.find((r) => r.path === wanted.path);
      if (review) {
        setFocus(firstInFile(review));
        return;
      }
    }
    setFocus((current) => {
      if (!current) return answering.current > 0 ? null : nextOpen(reviews, null);
      const review = reviews.find((r) => r.path === current.path);
      if (!review) return nextOpen(reviews, null);
      return review.blocks.some((b) => b.key === current.key) ? current : firstInFile(review);
    });
  }, [files, reviews, p.select?.path, p.select?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  // The diff of the file in focus, fetched again whenever what it would show moves.
  const listedFocus = focused && !focused.gone && focused.file.blocks ? focused.file : null;
  const focusKey = listedFocus ? changeKey(listedFocus) : "";
  useEffect(() => {
    if (!projectName || !sessionId || !listedFocus) return;
    const request = new AbortController();
    const key = focusKey;
    fetchSessionFileDiff(projectName, sessionId, listedFocus.path, request.signal)
      .then((next) => { if (!request.signal.aborted) setDiff(next); })
      .catch((e) => {
        if (request.signal.aborted) return;
        setDiffError({ key, message: e instanceof Error ? e.message : "Could not load this file's diff" });
      });
    return () => request.abort();
  }, [projectName, sessionId, focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pane = useMemo((): ReviewPane => {
    if (!focused) return { kind: "none" };
    const ghosts = reverted.get(focused.path) ?? [];
    const filePending = new Map<string, BlockState>();
    for (const b of focused.blocks) {
      const state = pending.get(answerKey(focused.path, b.key));
      if (state) filePending.set(b.key, state);
    }
    let source: { original: string; modified: string; version: string; base: string; kept: Set<string>; calls?: Map<string, string[]> } | null = null;
    if (focused.gone) {
      const record = gone.get(focused.path);
      // Every change reverted: the file is back to what it was compared with.
      if (record && record.text !== null) source = { original: record.text, modified: record.text, version: "", base: record.file.base ?? "", kept: new Set() };
    } else if (focused.file.blocks) {
      // A newer version keeps the one on screen up until it lands.
      if (diff?.path !== focused.path) {
        return diffError?.key === focusKey ? { kind: "error", message: diffError.message } : { kind: "loading" };
      }
      // Kept answers from the list, which every answer updates; the diff is fetched again only
      // when the file's text moves, and an answer that keeps or reopens a block does not move it.
      const kept = new Set((focused.file.blocks ?? []).filter((b) => b.kept).map((b) => b.key));
      const calls = new Map((focused.file.blocks ?? []).flatMap((b) => (b.calls?.length ? [[b.key, b.calls] as const] : [])));
      source = { original: diff.original, modified: diff.modified, version: diff.version, base: diff.base ?? "", kept, calls };
    }
    const model = source && paneModel({ ...source, reverted: ghosts, pending: filePending });
    if (!source || !model) return { kind: "whole", review: focused, undoId: focused.gone ? gone.get(focused.path)?.undoId : undefined };
    return { kind: "blocks", review: focused, model, version: source.version, original: source.original, base: source.base };
  }, [focused, reverted, gone, pending, diff, diffError, focusKey]);

  // Let go of reverted blocks the agent wrote over, or cut against a base that has moved.
  const staleKeys = pane.kind === "blocks" ? pane.model.stale.join("\n") : "";
  useEffect(() => {
    if (!staleKeys || pane.kind !== "blocks") return;
    const path = pane.review.path;
    const drop = new Set(staleKeys.split("\n"));
    setReverted((current) => new Map(current).set(path, (current.get(path) ?? []).filter((g) => !drop.has(g.key))));
  }, [staleKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastId = useRef(0);
  const showToast = useCallback((t: Omit<ReviewToast, "id">) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    const id = ++toastId.current;
    setToast({ ...t, id });
    toastTimer.current = setTimeout(() => setToast((cur) => (cur?.id === id ? null : cur)), TOAST_MS);
  }, []);
  const dismissToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  /** The version to send for a file drawn at `drawn`: past every version our own answers made. */
  const sendVersion = (path: string, drawn: string): string => {
    const chain = versionAfter.current.get(path);
    let version = drawn;
    for (let hops = 0; chain?.has(version) && hops < 64; hops++) version = chain.get(version)!;
    return version;
  };
  const noteVersion = (path: string, from: string, to: string) => {
    if (from === to) return;
    const chain = versionAfter.current.get(path) ?? new Map<string, string>();
    versionAfter.current.set(path, chain.set(from, to));
  };

  /** Put the server's word on each file into the list. */
  const takeAnswers = (answers: { path: string; file: SessionFileChange | null }[]) => {
    const byPath = new Map(answers.map((a) => [a.path, a.file]));
    setFiles((current) => {
      if (!current) return current;
      const next = current.flatMap((f) => (byPath.has(f.path) ? (byPath.get(f.path) ? [byPath.get(f.path)!] : []) : [f]));
      for (const a of answers) if (a.file && !current.some((f) => f.path === a.path)) next.push(a.file);
      return next;
    });
    setOrder((prev) => {
      const added = answers.filter((a) => a.file && !prev.includes(a.path)).map((a) => a.path);
      return added.length ? [...prev, ...added] : prev;
    });
    // A file brought back by Undo is listed again.
    setGone((current) => {
      if (!answers.some((a) => a.file && current.has(a.path))) return current;
      const next = new Map(current);
      for (const a of answers) if (a.file) next.delete(a.path);
      return next;
    });
  };

  /** What to say when a file moved on before its answer reached it. Returns whether it did. */
  const sayRefused = (answers: SessionFileAnswer[]) => {
    const refused = answers.find((a) => a.stale || a.error);
    if (!refused) return false;
    showToast(refused.error
      ? { lead: refused.error }
      : { lead: "", name: baseName(refused.path), tail: " changed before the answer reached it, so it is shown again as it is now." });
    return true;
  };

  /** Run `job` after every answer before it, with lists held off while it is on its way. */
  const enqueue = <T,>(job: () => Promise<T>): Promise<T> => {
    answering.current++;
    const run = async () => {
      try {
        return await job();
      } finally {
        answering.current--;
        lastAnswerAt.current = performance.now();
        if (projectName && sessionId) announceReviewMarks({ projectName, sessionId });
      }
    };
    const next = queue.current.then(run, run);
    queue.current = next;
    return next;
  };

  /**
   * Send one answer about `targets`. `states` and `ghosts` are what it shows at once: block
   * states, and blocks to keep showing as reverted. Null when it did not reach the server.
   */
  const send = (answer: SessionAnswer, targets: Target[], shown: { states?: Map<string, BlockState>; ghosts?: Map<string, RevertedBlock[]> }) => {
    if (!projectName || !sessionId || targets.length === 0) return Promise.resolve(null);
    const states = shown.states ?? new Map<string, BlockState>();
    const ghosts = shown.ghosts ?? new Map<string, RevertedBlock[]>();
    if (states.size) setPending((current) => new Map([...current, ...states]));
    if (ghosts.size) {
      setReverted((current) => {
        const next = new Map(current);
        for (const [path, list] of ghosts) next.set(path, [...(current.get(path) ?? []).filter((g) => !list.some((n) => n.key === g.key)), ...list]);
        return next;
      });
    }
    const updateGhosts = (fn: (g: RevertedBlock, path: string) => RevertedBlock | null) => {
      setReverted((current) => {
        const next = new Map(current);
        for (const [path, list] of ghosts) {
          next.set(path, (current.get(path) ?? []).flatMap((g) => (list.includes(g) ? [fn(g, path)].filter((x): x is RevertedBlock => !!x) : [g])));
        }
        return next;
      });
    };
    return enqueue(async () => {
      const body = targets.map((t) => ({ path: t.review.path, version: sendVersion(t.review.path, t.drawn), ...(t.keys ? { keys: t.keys } : {}) }));
      try {
        const result = await answerSessionChanges(projectName, sessionId, answer, body);
        const refused = new Set(result.files.filter((f) => f.stale || f.error).map((f) => f.path));
        // Undo needs the revert's id; the reverted blocks themselves already show.
        updateGhosts((g, path) => (refused.has(path) ? null : { ...g, undoId: result.undoId }));
        result.files.forEach((f, i) => {
          if (!refused.has(f.path)) noteVersion(f.path, body[i]?.version ?? "", f.file?.version ?? "");
        });
        if (answer === "revert") {
          const away = targets.filter((t) => result.files.some((f) => f.path === t.review.path && !refused.has(f.path) && !f.file));
          if (away.length) {
            setGone((current) => {
              const next = new Map(current);
              for (const t of away) next.set(t.review.path, { file: t.review.file, text: t.text ?? null, undoId: result.undoId });
              return next;
            });
          }
        }
        takeAnswers(result.files);
        return result;
      } catch (e) {
        updateGhosts(() => null);
        showToast({ lead: e instanceof Error ? e.message : "Could not save the answer" });
        return null;
      } finally {
        if (states.size) {
          setPending((current) => {
            const next = new Map(current);
            for (const k of states.keys()) next.delete(k);
            return next;
          });
        }
      }
    });
  };

  /** The version a file was drawn at: the diff on screen for the file in focus, the list's otherwise. */
  const drawnVersion = (review: FileReview) =>
    pane.kind === "blocks" && pane.review.path === review.path ? pane.version : review.file.version;

  const blockItem = (key: string): BlockItem | undefined =>
    pane.kind === "blocks" ? pane.model.items.find((i): i is BlockItem => i.kind === "block" && i.key === key) : undefined;

  /** Reviews as they will be once `states` land: where focus goes next. */
  const reviewsWith = (states: ReadonlyMap<string, BlockState>) =>
    fileReviews({ order, files: files ?? [], reverted, gone, pending: new Map([...pending, ...states]) });

  /** Keep or revert one block of the file in focus. */
  const answerBlock = async (key: string, answer: "keep" | "revert") => {
    if (!focused || focused.gone) return;
    const review = focused;
    const item = blockItem(key);
    const states = new Map([[answerKey(review.path, key), (answer === "keep" ? "kept" : "reverted") as BlockState]]);
    const after = reviewsWith(states);
    setFocus(nextOpen(after, { path: review.path, key }));
    const ghosts = answer === "revert" && item && pane.kind === "blocks" ? new Map([[review.path, [ghostOf(item, pane)]]]) : undefined;
    const fileText = pane.kind === "blocks" ? pane.original : null;
    const result = await send(answer, [{ review, drawn: drawnVersion(review), keys: key === WHOLE_FILE ? undefined : [key], text: fileText }], { states, ghosts });
    if (!result || sayRefused(result.files)) return;
    const done = after.find((r) => r.path === review.path)?.open === 0;
    showToast({
      lead: `${answer === "keep" ? "Kept" : "Reverted"} ${item ? `block ${item.index + 1} of ` : ""}`,
      name: baseName(review.path),
      tail: done ? " — file done" : "",
      undoId: result.undoId,
      focus: { path: review.path, key },
    });
  };

  /** Open a kept block again (Change). */
  const reopenBlock = async (key: string) => {
    if (!focused || focused.gone) return;
    const review = focused;
    const item = blockItem(key);
    setFocus({ path: review.path, key });
    const result = await send("open", [{ review, drawn: drawnVersion(review), keys: key === WHOLE_FILE ? undefined : [key] }], {
      states: new Map([[answerKey(review.path, key), "open" as BlockState]]),
    });
    if (!result || sayRefused(result.files)) return;
    showToast({ lead: item ? `Block ${item.index + 1} of ` : "", name: baseName(review.path), tail: " is open again", undoId: result.undoId, focus: { path: review.path, key } });
  };

  /** Undo an answer: the toast's, or a reverted block's (Change). */
  const undo = (undoId: string, focusBack?: Focus | null) => {
    if (!projectName || !sessionId) return Promise.resolve();
    dismissToast();
    return enqueue(async () => {
      try {
        const result = await undoSessionAnswer(projectName, sessionId, undoId);
        if (result.stale) {
          showToast({ lead: "Could not undo: the file changed since." });
          return;
        }
        for (const f of result.files) {
          const before = files?.find((x) => x.path === f.path)?.version;
          if (before !== undefined && f.file) noteVersion(f.path, before, f.file.version);
        }
        setReverted((current) => {
          const next = new Map<string, RevertedBlock[]>();
          for (const [path, list] of current) next.set(path, list.filter((g) => g.undoId !== undoId));
          return next;
        });
        takeAnswers(result.files);
        if (focusBack) setFocus(focusBack);
      } catch (e) {
        showToast({ lead: e instanceof Error ? e.message : "Could not undo" });
      }
    });
  };

  /** Keep every open block of the file in focus. */
  const keepFile = async () => {
    if (!focused || focused.gone || focused.open === 0) return;
    const review = focused;
    const open = review.blocks.filter((b) => b.state === "open").map((b) => b.key);
    const states = new Map(open.map((k) => [answerKey(review.path, k), "kept" as BlockState]));
    setFocus(nextOpen(reviewsWith(states), { path: review.path, key: review.blocks[review.blocks.length - 1]!.key }));
    const result = await send("keep", [{ review, drawn: drawnVersion(review), keys: open.includes(WHOLE_FILE) ? undefined : open }], { states });
    if (!result || sayRefused(result.files)) return;
    showToast({ lead: "Kept ", name: baseName(review.path), undoId: result.undoId, focus: firstInFile(review) });
  };

  /** Revert the whole file in focus, kept blocks included. */
  const revertFile = async () => {
    if (!focused || focused.gone) return;
    const review = focused;
    const states = new Map(review.blocks.filter((b) => b.state !== "reverted").map((b) => [answerKey(review.path, b.key), "reverted" as BlockState]));
    setFocus(nextOpen(reviewsWith(states), { path: review.path, key: review.blocks[review.blocks.length - 1]!.key }));
    const ghosts = pane.kind === "blocks" && pane.review.path === review.path
      ? new Map([[review.path, pane.model.items.filter((i): i is BlockItem => i.kind === "block" && i.state !== "reverted").map((i) => ghostOf(i, pane))]])
      : undefined;
    const fileText = pane.kind === "blocks" ? pane.original : null;
    const result = await send("revert", [{ review, drawn: drawnVersion(review), text: fileText }], { states, ghosts });
    if (!result || sayRefused(result.files)) return;
    showToast({ lead: "Reverted ", name: baseName(review.path), undoId: result.undoId, focus: firstInFile(review) });
  };

  /** Keep every open block of every file. */
  const keepAll = async () => {
    const targets = reviews.filter((r) => r.open > 0 && !r.gone);
    if (targets.length === 0) return;
    const states = new Map(targets.flatMap((r) => r.blocks.filter((b) => b.state === "open").map((b) => [answerKey(r.path, b.key), "kept" as BlockState] as const)));
    const back = focus;
    setFocus(null);
    const result = await send("keep", targets.map((review) => {
      const open = review.blocks.filter((b) => b.state === "open").map((b) => b.key);
      return { review, drawn: drawnVersion(review), keys: open.includes(WHOLE_FILE) ? undefined : open };
    }), { states });
    if (!result || sayRefused(result.files)) return;
    showToast({ lead: `Kept ${states.size} block${states.size === 1 ? "" : "s"}`, undoId: result.undoId, focus: back });
  };

  const step = useCallback((by: 1 | -1) => setFocus((current) => stepBlock(reviews, current, by)), [reviews]);
  const focusFile = useCallback((path: string) => {
    const review = reviews.find((r) => r.path === path);
    if (review) setFocus(firstInFile(review));
  }, [reviews]);

  return {
    files,
    reviews,
    progress,
    focus,
    setFocus,
    focused,
    pane,
    loading,
    error,
    toast,
    dismissToast,
    reload: loadList,
    step,
    focusFile,
    keepBlock: (key: string) => answerBlock(key, "keep"),
    revertBlock: (key: string) => answerBlock(key, "revert"),
    reopenBlock,
    undo,
    keepFile,
    revertFile,
    keepAll,
  };
}

export type SessionReview = ReturnType<typeof useSessionReview>;
