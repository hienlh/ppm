/**
 * The Review changes tab's state and actions.
 *
 * The list is `useGitChanges` — the same answer Source Control reads — and the
 * lines come from `GET /git/changes/file`, for the file in view and the next
 * ones an answer or a Next file would move to. A discard made here stays on
 * screen, where it was, with its Undo; git itself no longer lists it.
 *
 * Every answer shows at once: the block takes its new state and the focus
 * moves on before git has replied (`pending`). The writes themselves run one
 * at a time, in the order they were asked for, each naming its block by where
 * that block sits *after* the writes before it — an earlier block staged in the
 * same file moves every later one up the list, and a discard refuses a block
 * that is not where the request says.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast as notify } from "sonner";
import { api } from "@/lib/api-client";
import { useGitRepo } from "@/hooks/use-git-repo";
import { useGitChanges } from "@/hooks/use-git-changes";
import { splitPath, syncMode, unstagePaths, type ChangeTotals } from "@/lib/git-changes-view";
import {
  blockId,
  fileReviews,
  fileSignature,
  firstInFile,
  hunkIndex,
  nextFileFocus,
  nextOpen,
  paneItems,
  pickRequest,
  resolveFocus,
  reviewTotals,
  stepFocus,
  type DiscardedEntry,
  type FileReview,
  type PaneItem,
  type ReviewBlock,
  type ReviewBlockState,
  type ReviewFocus,
  type ReviewTotals,
} from "@/lib/git-review-model";
import type { CommitOptions } from "@/components/git/git-commit-composer";
import type { ChangedFile, ChangeHunk, DiscardRecord, FileChangeDetail, GitChanges } from "../../shared/git-changes";

const TOAST_MS = 7000;

export interface ReviewToast {
  id: number;
  text: string;
  undo?: () => void;
}

/** Where the focus should be: a block, and where it sat, for when git answers with a new key. */
type Want = (ReviewFocus & { anchor?: number }) | null;

export interface GitReview {
  changes: GitChanges | null;
  error: string | null;
  reviews: FileReview[];
  conflicts: ChangedFile[];
  totals: ReviewTotals;
  /** For the commit box: the same counts, in its terms. */
  commitTotals: ChangeTotals;
  focus: ReviewFocus | null;
  focused: { review: FileReview; block: ReviewBlock; index: number } | null;
  /** The focused file's blocks with the unchanged stretches between them. */
  items: PaneItem[];
  /** The line pick on the focused block: which of its lines are ticked. */
  pick: ReadonlySet<number> | null;
  /** The write in flight, if any. */
  busy: string | null;
  toast: ReviewToast | null;
  dismissToast: () => void;

  focusBlock: (path: string, key: string) => void;
  focusFile: (path: string) => void;
  step: (dir: 1 | -1) => void;
  nextFile: () => void;

  stage: (path: string, key: string) => void;
  discard: (path: string, key: string) => void;
  unstage: (path: string, key: string) => void;
  undoDiscard: (recordId: string) => void;
  stageFile: (path: string) => void;
  discardFile: (path: string) => void;
  stageAll: () => void;

  /** Tick lines of a block of the file in view: the focused one when no key is given. */
  startPick: (key?: string) => void;
  togglePickLine: (line: number) => void;
  setPick: (lines: number[] | null) => void;
  stagePicked: () => void;

  commit: (message: string, options: CommitOptions) => Promise<boolean>;
  /** The commit the composer shows unless told which: refused once it is no longer the last. */
  undoCommit: (hash?: string) => Promise<void>;
}

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useGitReview(projectName: string | undefined, select?: { path?: string; at?: number }): GitReview {
  const gitRepo = useGitRepo(projectName);
  const url = gitRepo.gitUrl;
  const { changes, error, refresh } = useGitChanges(projectName);
  const files = useMemo(() => changes?.files ?? [], [changes]);

  const [details, setDetails] = useState<ReadonlyMap<string, FileChangeDetail>>(new Map());
  const [discards, setDiscards] = useState<readonly DiscardedEntry[]>([]);
  const [pending, setPending] = useState<ReadonlyMap<string, ReviewBlockState>>(new Map());
  const [want, setWant] = useState<Want>(null);
  const [picking, setPicking] = useState<{ path: string; key: string; lines: ReadonlySet<number> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<ReviewToast | null>(null);

  // What the queued writes read. A write starts as soon as the one before it settled, which is
  // before React has rendered what it set — so these are written with the state, not from it.
  const detailsRef = useRef(details);
  const updateDetails = (fn: (cur: ReadonlyMap<string, FileChangeDetail>) => Map<string, FileChangeDetail>) => {
    const next = fn(detailsRef.current);
    detailsRef.current = next;
    setDetails(next);
  };
  const discardsRef = useRef(discards);
  const updateDiscards = (fn: (cur: readonly DiscardedEntry[]) => DiscardedEntry[]) => {
    const next = fn(discardsRef.current);
    discardsRef.current = next;
    setDiscards(next);
  };
  const changesRef = useRef(changes);
  if (changes) changesRef.current = changes;

  // A discard is undone in the repository that kept it: shown on another one, its Undo
  // can only fail. Its toast goes with it.
  const repoPath = gitRepo.repo?.path;
  const reviewedRepo = useRef(repoPath);
  useEffect(() => {
    if (reviewedRepo.current === repoPath) return;
    reviewedRepo.current = repoPath;
    updateDiscards(() => []);
    setToast(null);
  }, [repoPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const reviews = useMemo(() => fileReviews({ files, details, discards, pending }), [files, details, discards, pending]);
  const conflicts = useMemo(() => files.filter((f) => f.conflict), [files]);
  const totals = useMemo(() => reviewTotals(reviews), [reviews]);
  const commitTotals = useMemo<ChangeTotals>(() => ({
    files: totals.files,
    filesStaged: reviews.filter((r) => r.staged).length,
    blocks: totals.blocks,
    blocksStaged: totals.staged,
    conflicts: conflicts.length,
  }), [reviews, totals, conflicts]);

  const focus = useMemo(() => resolveFocus(reviews, want), [reviews, want]);
  const focused = useMemo(() => {
    const review = focus && reviews.find((r) => r.path === focus.path);
    const index = review ? review.blocks.findIndex((b) => b.key === focus!.key) : -1;
    return review && index >= 0 ? { review, block: review.blocks[index]!, index } : null;
  }, [reviews, focus]);
  const items = useMemo(() => (focused ? paneItems(focused.review.blocks) : []), [focused]);

  // Once git's answer moved the focus somewhere else, that is where it stays.
  useEffect(() => {
    if (!focus || (want && focus.path === want.path && focus.key === want.key)) return;
    const block = focused?.block;
    setWant({ ...focus, anchor: block?.anchor });
  }, [focus, want, focused]);

  // A pick belongs to one block: moving anywhere else drops it.
  const pick = picking && focus && picking.path === focus.path && picking.key === focus.key ? picking.lines : null;
  useEffect(() => {
    if (picking && !pick) setPicking(null);
  }, [picking, pick]);

  // Opened on a file (Source Control's row, the graph): show it once git has listed it.
  const selected = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!select?.path || select.at === selected.current || !changes) return;
    const review = reviews.find((r) => r.path === select.path);
    selected.current = select.at;
    const target = review && firstInFile(review);
    if (target) setWant(target);
  }, [select?.path, select?.at, reviews, changes]);

  /* ---------- lines ---------- */

  const fetchDetail = useCallback(async (file: Pick<ChangedFile, "path" | "oldPath">): Promise<FileChangeDetail> => {
    const query = `?path=${encodeURIComponent(file.path)}${file.oldPath ? `&oldPath=${encodeURIComponent(file.oldPath)}` : ""}`;
    return api.get<FileChangeDetail>(url(`/changes/file${query}`));
  }, [url]);

  // Which list entry each detail was read for, so a new block in the list reads it again.
  const detailSigs = useRef(new Map<string, string>());
  const writing = useRef(new Set<string>());
  // The file in view, and the ones an answer or Next file would move to.
  const wanted = useMemo(() => {
    const paths = new Set<string>();
    if (focus) paths.add(focus.path);
    const after = nextOpen(reviews, focus)?.path;
    if (after) paths.add(after);
    const next = nextFileFocus(reviews, focus?.path ?? null)?.path;
    if (next) paths.add(next);
    return [...paths].join("\0");
  }, [reviews, focus]);

  useEffect(() => {
    const paths = wanted ? wanted.split("\0") : [];
    const byPath = new Map(files.map((f) => [f.path, f]));
    const stale = [...detailsRef.current.keys()].filter((path) => {
      const file = byPath.get(path);
      return !file || (detailSigs.current.get(path) !== fileSignature(file) && !paths.includes(path));
    });
    if (stale.length) {
      for (const path of stale) detailSigs.current.delete(path);
      updateDetails((cur) => {
        const next = new Map(cur);
        for (const path of stale) next.delete(path);
        return next;
      });
    }
    for (const path of paths) {
      const file = byPath.get(path);
      if (!file || file.conflict || writing.current.has(path)) continue;
      const sig = fileSignature(file);
      if (detailSigs.current.get(path) === sig) continue;
      detailSigs.current.set(path, sig);
      fetchDetail(file).then((detail) => {
        // Not if a newer read was asked for since, or a write is about to replace it.
        if (detailSigs.current.get(path) !== sig || writing.current.has(path)) return;
        updateDetails((cur) => new Map(cur).set(path, detail));
      }, () => {
        if (detailSigs.current.get(path) === sig) detailSigs.current.delete(path);
      });
    }
  }, [files, wanted, fetchDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- toasts ---------- */

  const toastId = useRef(0);
  const showToast = useCallback((text: string, undo?: () => void) => {
    setToast({ id: ++toastId.current, text, undo });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  const dismissToast = useCallback(() => setToast(null), []);

  /* ---------- writes ---------- */

  const queue = useRef<Promise<unknown>>(Promise.resolve());
  function enqueue<T>(name: string, paths: string[], fn: () => Promise<T>, failure: string): Promise<T | null> {
    const run = async (): Promise<T | null> => {
      setBusy(name);
      for (const path of paths) writing.current.add(path);
      try {
        return await fn();
      } catch (e) {
        notify.error(failure, { description: errorText(e) });
        return null;
      } finally {
        for (const path of paths) writing.current.delete(path);
        setBusy(null);
      }
    };
    const result = queue.current.then(run, run);
    queue.current = result;
    return result;
  }

  /**
   * Reads the list and the written files' lines again, and swaps them in with
   * `then` in one render — so a block never vanishes between git dropping it
   * and its new form arriving.
   */
  async function settle(paths: string[], then?: () => void) {
    const byPath = new Map((changesRef.current?.files ?? []).map((f) => [f.path, f]));
    const [fresh, ...read] = await Promise.all([
      refresh(),
      ...paths.map((path) => fetchDetail(byPath.get(path) ?? { path }).catch(() => null)),
    ]);
    if (fresh) changesRef.current = fresh;
    // The read failed: the list held is the best there is until the next one lands.
    const listed = new Map((changesRef.current?.files ?? []).map((f) => [f.path, f]));
    updateDetails((cur) => {
      const next = new Map(cur);
      paths.forEach((path, i) => {
        const detail = read[i];
        const file = listed.get(path);
        if (detail && file) {
          next.set(path, detail);
          detailSigs.current.set(path, fileSignature(file));
        } else {
          next.delete(path);
          detailSigs.current.delete(path);
        }
      });
      return next;
    });
    then?.();
  }

  const findBlock = (path: string, key: string) => {
    const review = reviews.find((r) => r.path === path);
    return { review, block: review?.blocks.find((b) => b.key === key) };
  };

  /** Shows `state` on the blocks at once and, when the focus was on one of them, moves it on. */
  function optimistic(path: string, keys: string[], state: ReviewBlockState, moveOn: boolean): () => void {
    const ids = keys.map((key) => blockId(path, key));
    const mark = (cur: ReadonlyMap<string, ReviewBlockState>) => {
      const next = new Map(cur);
      for (const id of ids) next.set(id, state);
      return next;
    };
    setPending(mark);
    if (moveOn && focus && focus.path === path && keys.includes(focus.key)) {
      const after = nextOpen(fileReviews({ files, details, discards, pending: mark(pending) }), focus);
      if (after) setWant(after);
    }
    return () => setPending((cur) => {
      const left = new Map(cur);
      for (const id of ids) left.delete(id);
      return left;
    });
  }

  /** Where a block sits in the list git gives now — fetched first if the file's lines never loaded. */
  async function currentIndex(path: string, block: ReviewBlock): Promise<number> {
    let detail = detailsRef.current.get(path);
    if (!detail) {
      detail = await fetchDetail(changesRef.current?.files.find((f) => f.path === path) ?? { path });
    }
    const hunks = (block.side === "staged" ? detail.staged?.hunks : detail.unstaged?.hunks) ?? [];
    const index = hunkIndex(hunks, block.key);
    if (index === null) throw new Error("This block changed since it was shown. Look at it again, then answer.");
    return index;
  }

  /** The lines a discard takes, as on screen now: what the discarded block keeps showing. */
  function shownHunks(path: string, blocks: ReviewBlock[]): ChangeHunk[] {
    const hunks = detailsRef.current.get(path)?.unstaged?.hunks ?? [];
    return blocks.flatMap((b) => {
      const index = b.hunk ? hunkIndex(hunks, b.key) : null;
      const found = index === null ? undefined : hunks.find((h) => h.index === index);
      return found ? [found] : [];
    });
  }

  const recordDiscard = (entry: DiscardedEntry | null) => {
    if (entry) updateDiscards((cur) => [...cur, entry]);
  };

  const undoDiscard = (recordId: string) => {
    const entry = discardsRef.current.find((d) => d.recordId === recordId);
    if (!entry) return;
    setToast(null);
    void enqueue("undo", [entry.path], async () => {
      await api.post(url("/discard/undo"), { id: recordId });
      const first = entry.hunks[0];
      await settle([entry.path], () => {
        updateDiscards((cur) => cur.filter((d) => d.recordId !== recordId));
        // Its lines come back as the open block they were, under the same fingerprint.
        setWant({ path: entry.path, key: first ? `u:${first.id}` : "u:whole", anchor: first?.oldStart ?? 0 });
      });
      showToast(`Restored ${entry.hunks.length > 1 ? plural(entry.hunks.length, "block") : "the block"} in ${splitPath(entry.path)[1]}`);
    }, "Could not undo the discard");
  };

  const stage = (path: string, key: string) => {
    const { review, block } = findBlock(path, key);
    if (!review?.file || !block || block.state !== "open") return;
    const clear = optimistic(path, [key], "staged", true);
    void enqueue("stage", [path], async () => {
      try {
        if (!block.hunk) await api.post(url("/stage"), { files: [path] });
        else await api.post(url("/stage-hunks"), { path, hunks: [{ hunk: await currentIndex(path, block), id: block.hunk.id }] });
      } finally {
        await settle([path], clear);
      }
    }, "Could not stage");
  };

  const unstage = (path: string, key: string) => {
    const { review, block } = findBlock(path, key);
    if (!review?.file || !block || block.state !== "staged") return;
    const file = review.file;
    setWant({ path, key, anchor: block.anchor });
    const clear = optimistic(path, [key], "open", false);
    void enqueue("unstage", [path], async () => {
      try {
        if (!block.hunk) await api.post(url("/unstage"), { files: unstagePaths(file) });
        else await api.post(url("/unstage-hunks"), { path, hunks: [{ hunk: await currentIndex(path, block), id: block.hunk.id }] });
      } finally {
        await settle([path], clear);
      }
    }, "Could not unstage");
  };

  const discard = (path: string, key: string) => {
    const { review, block } = findBlock(path, key);
    if (!review?.file || !block || block.state !== "open") return;
    const file = review.file;
    const n = review.blocks.indexOf(block) + 1;
    const of = review.blocks.length;
    const clear = optimistic(path, [key], "discarded", true);
    void enqueue("discard", [path], async () => {
      try {
        let entry: DiscardedEntry | null;
        // A new file is one block, and discarding it deletes the file: the file route keeps a copy of it.
        if (!block.hunk || file.untracked) {
          const shown = shownHunks(path, [block]);
          const res = await api.post<{ undo: DiscardRecord | null }>(url("/discard"), { files: [path] });
          // A record that kept nothing (a file too large to copy) has no Undo to offer.
          entry = res.undo?.paths.length ? { path, recordId: res.undo.id, hunks: shown, whole: shown.length ? null : block.whole, added: block.added, removed: block.removed } : null;
        } else {
          const index = await currentIndex(path, block);
          const shown = detailsRef.current.get(path)?.unstaged?.hunks.find((h) => h.index === index);
          const res = await api.post<{ undo: DiscardRecord | null }>(url("/discard-hunks"), { path, hunks: [{ hunk: index, id: block.hunk.id }] });
          entry = res.undo && { path, recordId: res.undo.id, hunks: shown ? [shown] : [], whole: null, added: block.added, removed: block.removed };
        }
        recordDiscard(entry);
        const name = splitPath(path)[1];
        if (entry) showToast(`Discarded block ${n} of ${of} in ${name}`, () => undoDiscard(entry!.recordId));
        else notify.warning(`Discarded block ${n} of ${name}`, { description: "No copy of it could be kept, so this cannot be undone." });
      } finally {
        await settle([path], clear);
      }
    }, "Could not discard");
  };

  const stageFile = (path: string) => {
    const review = reviews.find((r) => r.path === path);
    const open = review?.blocks.filter((b) => b.state === "open") ?? [];
    if (!open.length) return;
    const clear = optimistic(path, open.map((b) => b.key), "staged", false);
    if (focus?.path === path) {
      const after = nextFileFocus(reviews, path);
      if (after) setWant(after);
    }
    void enqueue("stage", [path], async () => {
      try {
        await api.post(url("/stage"), { files: [path] });
      } finally {
        await settle([path], clear);
      }
    }, "Could not stage");
  };

  const discardFile = (path: string) => {
    const review = reviews.find((r) => r.path === path);
    const open = review?.blocks.filter((b) => b.state === "open") ?? [];
    if (!review?.file || !open.length) return;
    const clear = optimistic(path, open.map((b) => b.key), "discarded", true);
    void enqueue("discard", [path], async () => {
      try {
        const shown = shownHunks(path, open);
        const whole = shown.length === open.length ? null : open.find((b) => b.whole)?.whole ?? "empty";
        const added = open.reduce((n, b) => n + b.added, 0);
        const removed = open.reduce((n, b) => n + b.removed, 0);
        const res = await api.post<{ undo: DiscardRecord | null }>(url("/discard"), { files: [path] });
        // A record that kept nothing (a file too large to copy) has no Undo to offer.
        const entry = res.undo?.paths.length ? { path, recordId: res.undo.id, hunks: whole ? [] : shown, whole, added, removed } : null;
        recordDiscard(entry);
        const name = splitPath(path)[1];
        if (entry) showToast(`Discarded ${plural(open.length, "block")} in ${name}`, () => undoDiscard(entry.recordId));
        else notify.warning(`Discarded the changes to ${name}`, { description: "No copy of them could be kept, so this cannot be undone." });
      } finally {
        await settle([path], clear);
      }
    }, "Could not discard");
  };

  const stageAll = () => {
    const targets = reviews.filter((r) => r.file && r.open);
    if (!targets.length) return;
    const clears = targets.map((r) => optimistic(r.path, r.blocks.filter((b) => b.state === "open").map((b) => b.key), "staged", false));
    void enqueue("stage", targets.map((r) => r.path), async () => {
      try {
        await api.post(url("/stage"), { files: targets.map((r) => r.path) });
        showToast(`Staged ${plural(targets.length, "file")}`);
      } finally {
        await settle(focus ? [focus.path] : [], () => clears.forEach((c) => c()));
      }
    }, "Could not stage");
  };

  /* ---------- line picks ---------- */

  const startPick = (key?: string) => {
    if (!focused) return;
    const path = focused.review.path;
    const block = key ? focused.review.blocks.find((b) => b.key === key) : focused.block;
    if (!block || block.state !== "open" || !block.hunk || !block.parts) return;
    setWant({ path, key: block.key, anchor: block.anchor });
    setPicking({ path, key: block.key, lines: new Set() });
  };
  const togglePickLine = (line: number) => {
    setPicking((cur) => {
      if (!cur) return cur;
      const lines = new Set(cur.lines);
      if (!lines.delete(line)) lines.add(line);
      return { ...cur, lines };
    });
  };
  const setPick = (lines: number[] | null) => setPicking((cur) => (cur && lines ? { ...cur, lines: new Set(lines) } : null));

  const stagePicked = () => {
    const target = focused;
    if (!target || !pick || !target.block.hunk) return;
    const lines = pickRequest(target.block, pick);
    if (lines?.length === 0) return;
    const { review, block } = target;
    const count = lines ? lines.length : pick.size;
    void enqueue("stage-lines", [review.path], async () => {
      try {
        const index = await currentIndex(review.path, block);
        await api.post(url("/stage-hunks"), { path: review.path, hunks: [{ hunk: index, id: block.hunk!.id, ...(lines ? { lines } : {}) }] });
        showToast(lines ? `Staged ${plural(count, "line")} — the rest of the block stays open` : "Staged the block");
      } finally {
        // What is left of the block is a new block: the focus finds it by where it sat.
        await settle([review.path], () => {
          setPicking(null);
          setWant({ path: review.path, key: block.key, anchor: block.anchor });
        });
      }
    }, "Could not stage those lines");
  };

  /* ---------- moving ---------- */

  const focusBlock = useCallback((path: string, key: string) => setWant({ path, key }), []);
  const focusFile = (path: string) => {
    const review = reviews.find((r) => r.path === path);
    const target = review && firstInFile(review);
    if (target) setWant(target);
  };
  const step = (dir: 1 | -1) => {
    const target = stepFocus(reviews, focus, dir);
    if (target) setWant(target);
  };
  const nextFile = () => {
    const target = nextFileFocus(reviews, focus?.path ?? null);
    if (target) setWant(target);
  };

  /* ---------- commits ---------- */

  const undoCommit = async (hash = changesRef.current?.lastCommit?.hash) => {
    await enqueue("undo-commit", [], async () => {
      await api.post(url("/commit/undo"), { hash });
      await settle(focus ? [focus.path] : []);
      showToast("Commit undone — its changes are staged again");
    }, "Could not undo the commit");
  };

  const commit = async (message: string, options: CommitOptions): Promise<boolean> => {
    const before = changesRef.current;
    const staged = commitTotals.filesStaged;
    const done = await enqueue("commit", [], async () => {
      const { hash } = await api.post<{ hash: string }>(url("/commit"), { message, amend: !!options.amend, signoff: !!options.signoff });
      await settle(focus ? [focus.path] : []);
      return hash;
    }, options.amend ? "Could not amend the commit" : "Could not commit");
    if (!done) return false;
    const short = done.slice(0, 7);
    if (options.amend) showToast(`Amended ${short}`);
    else showToast(`Committed ${short} · ${plural(staged, "file")}`, () => void undoCommit(done));
    if (options.push && before) {
      // A branch with no upstream yet is published, not pushed.
      const publish = syncMode(before.branch) === "publish";
      const pushed = await enqueue("push", [], async () => {
        await api.post(url(publish ? "/publish" : "/push"), {});
        await refresh();
        return true;
      }, publish ? "Publish failed" : "Push failed");
      if (pushed) showToast(publish ? `Published ${before.branch.head ?? "the branch"}` : `Pushed ${short} to ${before.branch.upstream ?? "the remote"}`);
    }
    return true;
  };

  return {
    changes,
    error,
    reviews,
    conflicts,
    totals,
    commitTotals,
    focus,
    focused,
    items,
    pick,
    busy,
    toast,
    dismissToast,
    focusBlock,
    focusFile,
    step,
    nextFile,
    stage,
    discard,
    unstage,
    undoDiscard,
    stageFile,
    discardFile,
    stageAll,
    startPick,
    togglePickLine,
    setPick,
    stagePicked,
    commit,
    undoCommit,
  };
}
