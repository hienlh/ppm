import { useCallback, useEffect, useRef, useState } from "react";
import { getDesign } from "@/lib/design/api-designs";
import type { DesignSummary } from "../../../shared/design-types";

export type DesignSummaryState =
  | { status: "loading" }
  | { status: "ready"; design: DesignSummary }
  | { status: "missing" }
  | { status: "error"; message: string };

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
      .then((design) => { if (request === latest.current) setState({ status: "ready", design }); })
      .catch((e: Error & { status?: number }) => {
        if (request !== latest.current) return;
        const notFound = e.status === 404 || /not found/i.test(e.message ?? "");
        setState(notFound ? { status: "missing" } : { status: "error", message: e.message || "Could not load the design" });
      });
  }, [projectName, slug, version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return { state, refresh };
}
