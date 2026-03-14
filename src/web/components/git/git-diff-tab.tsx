import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../../lib/api-client.ts";
import "diff2html/bundles/css/diff2html.min.css";

interface Props {
  projectPath: string;
  filePath?: string;
  ref?: string;
}

export function GitDiffTab({ projectPath, filePath, ref: gitRef }: Props) {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    let url: string;
    if (filePath) {
      const params = new URLSearchParams({ file: filePath });
      if (gitRef) params.set("ref", gitRef);
      url = `/api/git/file-diff/${encodeURIComponent(projectPath)}?${params}`;
    } else if (gitRef) {
      url = `/api/git/diff/${encodeURIComponent(projectPath)}?ref1=${encodeURIComponent(gitRef)}^&ref2=${encodeURIComponent(gitRef)}`;
    } else {
      url = `/api/git/diff/${encodeURIComponent(projectPath)}`;
    }

    api
      .get<{ diff: string }>(url)
      .then((res) => setDiff(res.diff))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [projectPath, filePath, gitRef]);

  useEffect(() => {
    if (!diff || !containerRef.current) return;

    // Dynamically import diff2html to avoid SSR issues
    import("diff2html").then(({ html }) => {
      if (!containerRef.current) return;
      if (!diff.trim()) {
        containerRef.current.innerHTML =
          '<p class="text-muted-foreground text-sm p-4">No changes</p>';
        return;
      }
      containerRef.current.innerHTML = html(diff, {
        drawFileList: true,
        matching: "lines",
        outputFormat: "line-by-line",
      });
    });
  }, [diff]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-destructive text-sm px-4 text-center">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-xs text-muted-foreground shrink-0">
        {filePath && <span className="font-mono">{filePath}</span>}
        {gitRef && <span className="font-mono">{gitRef.slice(0, 7)}</span>}
        {!filePath && !gitRef && <span>Working tree changes</span>}
      </div>
      <div className="flex-1 overflow-auto p-2">
        <div ref={containerRef} className="diff2html-wrapper text-xs" />
      </div>
    </div>
  );
}
