/**
 * A text-like field that saves when it is left rather than on every keystroke: the due date and
 * the next step. It keeps what the user typed until it is really saved:
 *
 * - a blur, and also the field being removed (its popover closed, another task shown in it) while
 *   it holds something unsaved, saves it — browsers send no blur to an element that leaves the page;
 * - the same value is not sent twice while its answer is on the way, but a save that came back
 *   failed or stale (`null` from `useTaskWrite`'s `run`) is sent again on the next blur;
 * - when the stored value changes (the answer, or someone else's edit) the field follows it, unless
 *   it holds something typed since that has not been saved: that is not thrown away.
 */
import { useEffect, useRef, useState } from "react";

export interface SavedDraftOptions {
  /** The stored value, as the field shows it ("" for none). */
  shown: string;
  /** Whether a draft may be saved; one that may not goes back to `shown` when the field is left. */
  accept?(v: string): boolean;
  /** The value a draft saves as (the next step is trimmed). */
  normalize?(v: string): string;
  /** Saves; a `null` answer means it did not land and may be sent again. */
  onSave(v: string): unknown;
}

const same = (v: string) => v;
const always = () => true;

export function useSavedDraft({ shown, accept = always, normalize = same, onSave }: SavedDraftOptions) {
  const [draft, setDraft] = useState(shown);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // What was sent and has not been answered (or answered with something else than null).
  const saved = useRef<string | null>(null);
  const lastShown = useRef(shown);

  useEffect(() => {
    const before = lastShown.current;
    lastShown.current = shown;
    const d = normalize(draftRef.current);
    if (d === normalize(before) || d === saved.current || d === normalize(shown)) setDraft(shown);
    saved.current = null;
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = () => {
    const raw = draftRef.current;
    if (!accept(raw)) { setDraft(lastShown.current); return; }
    const v = normalize(raw);
    if (v === normalize(lastShown.current) || v === saved.current) return;
    saved.current = v;
    void Promise.resolve(onSave(v)).then((answer) => { if (answer === null && saved.current === v) saved.current = null; });
  };
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => () => latest.current(), []);

  return { draft, setDraft, commit };
}
