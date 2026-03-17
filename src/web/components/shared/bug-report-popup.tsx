import { useState, useEffect, useCallback } from "react";
import { Copy, ExternalLink, X, Check } from "lucide-react";
import { openGithubIssue, copyToClipboard } from "@/lib/report-bug";

export function BugReportPopup() {
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function handleOpen(e: Event) {
      const body = (e as CustomEvent).detail as string;
      if (body) {
        setText(body);
        setCopied(false);
      }
    }
    window.addEventListener("open-bug-report", handleOpen);
    return () => window.removeEventListener("open-bug-report", handleOpen);
  }, []);

  const close = useCallback(() => setText(null), []);

  if (!text) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={close} />
      <div className="fixed inset-4 md:inset-auto md:top-[15%] md:left-1/2 md:-translate-x-1/2 md:w-full md:max-w-lg md:max-h-[70vh] z-50 flex flex-col bg-background border border-border rounded-lg shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <span className="text-sm font-medium">Bug Report</span>
          <button onClick={close} className="p-1 rounded hover:bg-surface-elevated">
            <X className="size-4" />
          </button>
        </div>
        <pre className="flex-1 overflow-auto px-4 py-2 text-xs font-mono whitespace-pre-wrap break-all">{text}</pre>
        <div className="flex gap-2 p-3 border-t border-border">
          <button
            onClick={async () => {
              const ok = await copyToClipboard(text);
              if (ok) setCopied(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-elevated text-xs text-foreground hover:bg-surface transition-colors"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={() => { openGithubIssue(text); close(); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs hover:bg-primary/90 transition-colors"
          >
            <ExternalLink className="size-3" />
            Open GitHub Issue
          </button>
        </div>
      </div>
    </>
  );
}
