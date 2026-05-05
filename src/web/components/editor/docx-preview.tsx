import { useEffect, useState } from "react";
import { Loader2, FileWarning } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";

interface DocxPreviewProps {
  filePath: string;
  projectName?: string;
}

/** Preview .docx files by converting to HTML via mammoth on the backend */
export function DocxPreview({ filePath, projectName }: DocxPreviewProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const isExternal = /^(\/|[A-Za-z]:[/\\])/.test(filePath);
    const url = isExternal
      ? `/api/fs/docx-html?path=${encodeURIComponent(filePath)}`
      : `${projectUrl(projectName!)}/files/docx-html?path=${encodeURIComponent(filePath)}`;

    api
      .get<{ html: string }>(url)
      .then((data) => {
        setHtml(data.html);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to convert docx");
        setLoading(false);
      });
  }, [filePath, projectName]);

  // Re-fetch on file change events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.projectName !== projectName || detail.path !== filePath) return;

      const isExternal = /^(\/|[A-Za-z]:[/\\])/.test(filePath);
      const url = isExternal
        ? `/api/fs/docx-html?path=${encodeURIComponent(filePath)}`
        : `${projectUrl(projectName!)}/files/docx-html?path=${encodeURIComponent(filePath)}`;

      api.get<{ html: string }>(url).then((data) => setHtml(data.html)).catch(() => {});
    };
    window.addEventListener("file:changed", handler);
    return () => window.removeEventListener("file:changed", handler);
  }, [filePath, projectName]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-text-secondary">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Converting document...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <FileWarning className="size-10 text-text-subtle" />
        <p className="text-sm">Failed to load document.</p>
        <p className="text-xs text-text-subtle">{error}</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-white dark:bg-zinc-900">
      <div
        className="docx-preview max-w-3xl mx-auto px-6 py-8 text-sm text-foreground leading-relaxed
          [&_table]:border-collapse [&_table]:w-full [&_table]:my-3
          [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1
          [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold [&_th]:bg-muted/50
          [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded
          [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mt-6 [&_h1]:mb-3
          [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2
          [&_h3]:text-lg [&_h3]:font-medium [&_h3]:mt-4 [&_h3]:mb-2
          [&_p]:my-2
          [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-2
          [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-2
          [&_li]:my-0.5"
        dangerouslySetInnerHTML={{ __html: html ?? "" }}
      />
    </div>
  );
}
