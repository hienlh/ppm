/**
 * A pick list read from the server as a search is typed: once when the dialog opens, then after
 * typing pauses, at once on Enter, and again when `reloadKey` changes what is listed. An answer
 * to a search no longer in the box is dropped, however late it comes.
 */
import { useEffect, useRef, useState } from "react";

/** How long typing has to pause before the list is read again. */
export const PICK_SEARCH_DELAY_MS = 250;

export function usePickSearch<T>(load: (search: string) => Promise<T>, reloadKey = "") {
  const [search, setSearch] = useState("");
  // The search the list is for, which trails the box while typing.
  const [query, setQuery] = useState("");
  // `resultFor` is the search the result answers, which is not yet `query` while it loads.
  const [state, setState] = useState<{ result: T | null; resultFor: string; error: string | null; loading: boolean }>({ result: null, resultFor: "", error: null, loading: true });
  // The caller's `load` is a new function on every render; only the search and `reloadKey` read again.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => setQuery(search), PICK_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search, query]);

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    loadRef.current(query).then(
      (result) => { if (live) setState({ result, resultFor: query, error: null, loading: false }); },
      (e: unknown) => { if (live) setState({ result: null, resultFor: query, error: e instanceof Error ? e.message : String(e), loading: false }); },
    );
    return () => { live = false; };
  }, [query, reloadKey]);

  return { search, setSearch, searchNow: () => setQuery(search), query, ...state };
}
