/**
 * Replace All: asks first, then reports what happened (5.5, 5.7, 5.8).
 *
 * - The question counts what the list shows — dismissed matches and files left out
 *   (`countResults`), and says how many dismissed ones stay as they are.
 * - Replace sends exactly the listed matches (`buildReplaceFiles`). A file open with unsaved
 *   edits is never sent: writing under it would either be overwritten by its autosave or
 *   overwrite the edits, so it is named in the report as skipped instead.
 * - The report names every file skipped (unsaved, changed on disk since the search) or failed,
 *   with the reason. A refused request keeps the question open with the reason, to try again.
 *
 * Bottom sheet below `md`, centred dialog above, like the other confirmations.
 */
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { AlertCircle, AlertTriangle, Loader2 } from "@/lib/icons";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { buildReplaceFiles, countResults } from "@/lib/search/search-rows";
import type { ReplaceReport, ReplaceRequest, SearchResponse } from "../../../services/content-search/search-options";

export interface ReplaceAllDialogProps {
  response: SearchResponse | null;
  dismissed: ReadonlySet<string>;
  replaceText: string;
  /** True for a project file open in an editor tab with unsaved changes. */
  isUnsaved: (file: string) => boolean;
  /** Posts the files to replace; rejects when the request itself is refused. */
  onReplace: (files: ReplaceRequest["files"]) => Promise<ReplaceReport>;
  onSearchAgain: () => void;
  onClose: () => void;
}

interface ReportLine {
  file: string;
  kind: "skipped" | "failed";
  why: string;
}

interface Outcome {
  replaced: number;
  files: number;
  lines: ReportLine[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function totalMatches(response: SearchResponse | null): number {
  let n = 0;
  for (const result of response?.results ?? []) n += result.matches.length;
  return n;
}

export function ReplaceAllDialog({
  response,
  dismissed,
  replaceText,
  isUnsaved,
  onReplace,
  onSearchAgain,
  onClose,
}: ReplaceAllDialogProps) {
  const isMobile = useIsMobile();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const listed = countResults(response, dismissed);
  const dismissedCount = totalMatches(response) - listed.total;

  const replace = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    const { files, unsaved } = buildReplaceFiles(response, dismissed, { all: true }, isUnsaved);
    const unsavedLines: ReportLine[] = unsaved.map((file) => ({
      file,
      kind: "skipped",
      why: "Skipped: unsaved changes in an open tab. Save or discard them, then replace again.",
    }));
    try {
      const report = files.length > 0 ? await onReplace(files) : { replaced: 0, files: 0, skipped: [], failed: [] };
      setOutcome({
        replaced: report.replaced,
        files: report.files,
        lines: [
          ...unsavedLines,
          ...report.skipped.map((s): ReportLine => ({
            file: s.file,
            kind: "skipped",
            why: "Skipped: changed on disk since the search.",
          })),
          ...report.failed.map((f): ReportLine => ({ file: f.file, kind: "failed", why: `Failed: ${f.reason}.` })),
        ],
      });
    } catch (e) {
      setError((e as Error).message || "Replace failed");
    } finally {
      setRunning(false);
    }
  };

  const close = () => { if (!running) onClose(); };
  const buttonClass = "min-h-11 md:min-h-9";

  const title = outcome
    ? `Replaced ${plural(outcome.replaced, "occurrence", "occurrences")} in ${plural(outcome.files, "file", "files")}`
    : "Replace All";

  const body = outcome ? (
    <div className="space-y-4">
      {outcome.lines.length > 0 && (
        <ul className="max-h-72 space-y-2 overflow-y-auto text-sm">
          {outcome.lines.map((line) => (
            <li key={`${line.kind}:${line.file}`} className="flex gap-2">
              {line.kind === "failed"
                ? <AlertCircle className="mt-0.5 size-4 shrink-0 text-error" />
                : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />}
              <div className="min-w-0">
                <div className="break-all font-mono text-xs">{line.file}</div>
                <div className="text-xs text-text-3">{line.why}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button type="button" variant="outline" onClick={onSearchAgain} className={buttonClass}>Search again</Button>
        <Button type="button" onClick={onClose} className={buttonClass}>Done</Button>
      </div>
    </div>
  ) : (
    <div className="space-y-3">
      <p className="text-sm">
        Replace {plural(listed.total, "occurrence", "occurrences")} across {plural(listed.files, "file", "files")}{" "}
        {replaceText === "" ? "with nothing" : <>with <code className="break-all font-mono">{replaceText}</code></>}?
      </p>
      <p className="text-xs text-text-3">
        {dismissedCount > 0 && `${plural(dismissedCount, "dismissed match is", "dismissed matches are")} left as they are. `}
        Open editor tabs are updated; files with unsaved changes are skipped.
      </p>
      {error && <p className="text-xs text-error" role="alert">{error}</p>}
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button type="button" variant="outline" onClick={close} disabled={running} className={buttonClass}>Cancel</Button>
        <Button type="button" onClick={() => void replace()} disabled={running || listed.total === 0} className={buttonClass}>
          {running && <Loader2 className="size-4 animate-spin" />}Replace
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={close}>
        <div className="px-4 pb-4" data-testid="replace-all-dialog">
          <h2 className="mb-3 text-base font-semibold">{title}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="sm:max-w-md" data-testid="replace-all-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
