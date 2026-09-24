import { useCallback, useEffect, useRef, useState } from "react";
import { getDesign } from "@/lib/design/api-designs";
import type { DesignSummary } from "../../../shared/design-types";

export type DesignSummaryState =
  | { status: "loading" }
  | { status: "ready"; design: DesignSummary }
  | { status: "missing" }
  | { status: "error"; message: string };

export type DesignFetchResult =
  | { ok: true; design: DesignSummary }
  | { ok: false; notFound: true }
  | { ok: false; notFound: false; message: string };

/**
 * The state after one fetch, given what was on screen before it.
 *
 * A design already showing (`ready`) stays on screen through a transient refresh failure —
 * a network blip, a server restart mid-request — instead of the tab replacing the chat and
 * canvas with an empty state and losing whatever the user was doing. Only a 404, or a failure
 * before anything ever loaded, counts as truly missing or erroring.
 */
export function nextSummaryState(previous: DesignSummaryState, result: DesignFetchResult): DesignSummaryState {
  if (result.ok) return { status: "ready", design: result.design };
  if (result.notFound) return { status: "missing" };
  if (previous.status === "ready") return previous;
  return { status: "error", message: result.message };
}

/**
 * The design's manifest, refetched on demand (a `design.json` change, a rename).
 *
 * A 404 is its own state rather than an error: the folder was deleted, or a deep link names
 * a design that never existed, and the tab shows an empty state instead of a retry loop.
 * A refetch keeps showing the last good manifest until the new one arrives.
 */
export function useDesignSummary(projectName: string, slug: string) {
  const [state, setState] = useState<DesignSummaryState>({ status: "loading" });
  const [version, setVersion] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (!projectName || !slug) { setState({ status: "missing" }); return; }
    const request = ++latest.current;
    getDesign(projectName, slug)
      .then((design) => { if (request === latest.current) setState((prev) => nextSummaryState(prev, { ok: true, design })); })
      .catch((e: Error & { status?: number }) => {
        if (request !== latest.current) return;
        const notFound = e.status === 404 || /not found/i.test(e.message ?? "");
        setState((prev) => {
          const next = nextSummaryState(prev, notFound
            ? { ok: false, notFound: true }
            : { ok: false, notFound: false, message: e.message || "Could not load the design" });
          if (next === prev) console.warn(`[design] summary refresh for ${slug} failed, keeping the loaded design: ${e.message}`);
          return next;
        });
      });
  }, [projectName, slug, version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return { state, refresh };
}
