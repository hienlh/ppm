/**
 * Models for files the user has not opened.
 *
 * When a server answers "the definition is in `other.ts` line 40", Monaco can
 * only act on that if a model exists for that URI. Without one, F12 across
 * files does nothing at all and the peek widget opens empty — the single most
 * conspicuous way an editor can feel broken, because the feature appears to
 * work right up to the point it matters.
 *
 * There is no public way to give standalone Monaco a model *resolver*, so the
 * models are created ahead of time instead: a provider that is about to return
 * locations first makes sure a model exists for each of them. Monaco then finds
 * them by URI and renders peek, go-to-definition and find-all-references
 * natively, with no per-feature code.
 *
 * They are called shadow models because nothing shows them: no tab, no editor.
 * They exist only to be resolved by URI, so they are capped and evicted — the
 * contents of every file ever referenced would otherwise accumulate for the
 * life of the page.
 */
import type * as MonacoType from "monaco-editor";
import { api, projectUrl } from "@/lib/api-client";
import { fileUriToPath } from "../../../shared/lsp-uri";

/** How many unopened files to keep resolvable at once. */
const MAX_SHADOW_MODELS = 40;

/**
 * Bound on the negative cache.
 *
 * Every location outside the project lands here — `node_modules`, a toolchain's own library
 * types — and a session spent following types through a dependency tree reaches thousands. It
 * only exists to stop a miss being refetched per keystroke, so the recent ones are the only
 * ones worth keeping.
 */
const MAX_FAILED = 500;

/**
 * How many times a URI may fail before it stops being asked for.
 *
 * One failure is not evidence that a file is unfetchable: a 500, a dropped
 * socket or a tunnel that blinked all land in the same `catch` as a file that
 * genuinely is not there, and `api.get` throws a bare `Error` either way, so the
 * two cannot be told apart at the call site. Giving up on the first one made a
 * single blip disable go-to-definition into that file for the life of the page.
 * Counting instead costs a retry or two on a real miss and recovers by itself
 * from a transient one.
 */
const MAX_FETCH_ATTEMPTS = 3;

/**
 * At most this many file reads in flight at once.
 *
 * A find-all-references over a large symbol arrives as hundreds of locations,
 * and one request each is a burst the server answers slowly and the browser
 * queues anyway. The work is the same; only the shape of it changes.
 */
const MAX_CONCURRENT_FETCHES = 6;

/** Insertion-ordered, so the oldest is the first key. */
const shadows = new Map<string, MonacoType.editor.ITextModel>();

/** Consecutive failures per URI, so a miss is not refetched per keystroke. */
const failures = new Map<string, number>();

/** True once a URI has failed often enough to stop asking. */
function givenUpOn(uri: string): boolean {
  return (failures.get(uri) ?? 0) >= MAX_FETCH_ATTEMPTS;
}

function noteFailure(uri: string): void {
  recordFailure(uri, (failures.get(uri) ?? 0) + 1);
}

/**
 * A URI that can never be fetched, so it is not worth an attempt, let alone three.
 *
 * Goes through the same bookkeeping as an ordinary failure rather than writing the map
 * directly: every location outside the project lands here, which is the population the bound
 * below was written for, and a direct `set` would have left exactly that population uncapped.
 */
function giveUpOn(uri: string): void {
  recordFailure(uri, MAX_FETCH_ATTEMPTS);
}

function recordFailure(uri: string, count: number): void {
  // Deleted first so the entry moves to the end: a URI failing over and over would otherwise
  // keep the position of its first failure and be dropped before a colder one.
  failures.delete(uri);
  failures.set(uri, count);
  while (failures.size > MAX_FAILED) {
    const oldest = failures.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    failures.delete(oldest);
  }
}

/** A URI that answered is not a failure any more, whatever it did before. */
function noteSuccess(uri: string): void {
  failures.delete(uri);
}

/** Run `task` over `items`, at most `limit` at a time. */
async function inBatches<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      // Bounded by the index, not by a sentinel value: stopping at the first `undefined`
      // element would silently drop the rest of the list.
      if (index >= items.length) return;
      await task(items[index]!);
    }
  });
  await Promise.all(workers);
}

function relativeTo(projectPath: string, absolute: string): string | null {
  const root = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const path = absolute.replace(/\\/g, "/");
  const prefix = root + "/";
  // Windows only, and it is the difference between F12-across-files working and doing nothing
  // at all there: a language server answers with `file:///c%3A/Users/...` while the project is
  // configured as `C:\Users\...`, so a case-sensitive compare says every location is outside
  // the project, every one is cached as a failure, and no shadow model is ever created. The
  // relaxation is keyed on the path *shape*, so a POSIX path — where two names differing only
  // in case are two different files — is still compared exactly.
  const driveLetter = /^[A-Za-z]:\//.test(prefix);
  const head = path.slice(0, prefix.length);
  if (driveLetter ? head.toLowerCase() !== prefix.toLowerCase() : head !== prefix) return null;
  return path.slice(prefix.length);
}

/**
 * Make sure a model exists for each URI, fetching contents as needed.
 *
 * Failures are swallowed: a location can legitimately point outside the project
 * (into `node_modules`, or a library shipped with the toolchain), and losing
 * one entry of a reference list is much better than failing the provider and
 * losing all of them.
 */
export async function ensureShadowModels(
  monaco: typeof MonacoType,
  projectName: string,
  projectPath: string,
  uris: string[],
): Promise<void> {
  if (!projectPath) return;

  /** Every URI this call resolves, and therefore about to be returned to Monaco. */
  const resolved = new Set<string>();

  const wanted = [...new Set(uris)].filter((uri) => {
    if (givenUpOn(uri)) return false;
    const existing = shadows.get(uri);
    if (existing) {
      // Re-insert so the cap means "the 40 most recently needed" rather than "the 40 created
      // first": a file peeked at all afternoon stays the oldest key otherwise, and is the
      // first thing thrown away.
      shadows.delete(uri);
      if (!existing.isDisposed()) {
        shadows.set(uri, existing);
        // Part of this result set even though it cost no fetch — it was skipped *because* it
        // was already here, so disposing it below would blank the very locations it resolved.
        resolved.add(uri);
        return false;
      }
      // Disposed from somewhere else; the entry is a stale promise that a model exists.
    }
    // A URI the user has open already has a real model; the bridge rewrites
    // those to the model's own URI, so anything still `file:` is unopened.
    return uri.startsWith("file:") && !monaco.editor.getModel(monaco.Uri.parse(uri));
  });
  // Nothing to fetch means nothing was added, so the map cannot be over the cap.
  if (wanted.length === 0) return;

  await inBatches(wanted, MAX_CONCURRENT_FETCHES, async (uri) => {
    try {
      const absolute = fileUriToPath(uri);
      const relative = absolute ? relativeTo(projectPath, absolute) : null;
      if (!relative) {
        // Outside the project: not a failure to retry, it can never be fetched.
        giveUpOn(uri);
        return;
      }
      const result = await api.get<{ content?: string }>(
        `${projectUrl(projectName)}/files/read?path=${encodeURIComponent(relative)}`,
      );
      const content = result?.content;
      if (typeof content !== "string") {
        noteFailure(uri);
        return;
      }
      noteSuccess(uri);
      const parsed = monaco.Uri.parse(uri);
      // Another provider may have created it while this fetch was in flight.
      if (monaco.editor.getModel(parsed)) {
        resolved.add(uri);
        return;
      }
      // Language is left undefined so Monaco infers it from the URI's
      // extension, which is what gives the peek widget its highlighting.
      shadows.set(uri, monaco.editor.createModel(content, undefined, parsed));
      resolved.add(uri);
    } catch {
      // Everything is inside the try, not only the fetch: one URI must never be able to
      // reject the batch, because that would fail the provider and lose the whole result
      // list rather than the one entry.
      noteFailure(uri);
    }
  });

  evict(resolved);
}

/**
 * Trim to the cap, oldest first — but never a model this call is about to return.
 *
 * This used to run inside the creation loop, once per model. Find-all-references on a widely
 * used symbol asks for every location at once, so a result set larger than the cap disposed
 * its own earliest models before the provider had returned them: peek and find-references
 * opened empty for exactly the results that made the list long, which reads as a broken
 * feature rather than a full cache. A batch bigger than the cap is kept whole — the models
 * Monaco is about to resolve are the ones worth having.
 */
function evict(keep: ReadonlySet<string>): void {
  for (const uri of [...shadows.keys()]) {
    if (shadows.size <= MAX_SHADOW_MODELS) return;
    if (keep.has(uri)) continue;
    const model = shadows.get(uri);
    shadows.delete(uri);
    // Disposing a model Monaco is currently showing in a peek widget would
    // blank it, but a shadow model is never the active editor's model, so the
    // only reader is a widget that has already rendered.
    try {
      model?.dispose();
    } catch {
      // Already disposed.
    }
  }
}

/** Drop every shadow model, for when the last editor for a project closes. */
export function disposeShadowModels(): void {
  for (const model of shadows.values()) {
    try {
      model.dispose();
    } catch {
      // Already disposed.
    }
  }
  shadows.clear();
  failures.clear();
}
