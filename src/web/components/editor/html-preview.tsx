import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Loader2 } from "@/lib/icons";

/** The server also enforces the sandbox, including when a preview URL is opened directly. */
export function HtmlPreview({ filePath, projectName, revision }: {
  filePath: string;
  projectName?: string;
  revision: number;
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setUrl(undefined);
    setError(undefined);
    const timeout = setTimeout(() => controller.abort(new Error("Preview request timed out. Try Refresh.")), 30_000);
    let active = true;
    api.post<{ url: string }>("/api/html-preview", { filePath, projectName }, { signal: controller.signal })
      .then((data) => { if (active) setUrl(data.url); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Could not open HTML preview"); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [filePath, projectName, revision]);

  if (error) return <div role="alert" className="p-4 text-sm text-destructive">{error}. Use Refresh to retry.</div>;
  if (!url) return <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-5 animate-spin" />Loading preview…</div>;
  return <iframe title="HTML preview" src={url} sandbox="allow-scripts" referrerPolicy="no-referrer"
    className="flex-1 min-h-0 w-full border-0 bg-white" />;
}
