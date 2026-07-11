import { useEffect, useState, useCallback, useRef } from "react";
import { X, Loader2, TerminalSquare } from "lucide-react";
import { api } from "@/lib/api-client";
import { useBackgroundOutputStore } from "@/stores/background-output-store";

const POLL_MS = 1500;
/** Trim displayed output to the last ~500KB to avoid browser OOM. */
const MAX_CHARS = 500_000;

/** Global panel showing a background command's .output file — mount once in app root. */
export function BackgroundOutputPanel() {
  const panelShellId = useBackgroundOutputStore((s) => s.panelShellId);
  const getShell = useBackgroundOutputStore((s) => s.getShell);
  const closePanel = useBackgroundOutputStore((s) => s.closePanel);

  const shell = panelShellId ? getShell(panelShellId) : undefined;
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const outputPath = shell?.outputPath;
  const status = shell?.status;

  const fetchOnce = useCallback(async () => {
    if (!outputPath) return;
    try {
      const data = await api.get<{ content: string; path: string }>(
        `/api/fs/read?path=${encodeURIComponent(outputPath)}`,
      );
      const text = data.content ?? "";
      setContent(text.length > MAX_CHARS ? text.slice(-MAX_CHARS) : text);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [outputPath]);

  // Initial load + poll while the command is still running.
  useEffect(() => {
    if (!outputPath) return;
    setLoading(true);
    setContent("");
    fetchOnce();
    if (status !== "running") return;
    const id = setInterval(fetchOnce, POLL_MS);
    return () => clearInterval(id);
  }, [outputPath, status, fetchOnce]);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [content]);

  useEffect(() => {
    if (!panelShellId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closePanel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelShellId, closePanel]);

  if (!panelShellId) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={closePanel}
    >
      <div
        className="flex flex-col w-full md:max-w-3xl md:w-[90vw] max-h-[80vh] md:max-h-[75vh] overflow-hidden rounded-t-xl md:rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <TerminalSquare className="size-4 shrink-0 text-text-secondary" />
          <span className="flex-1 truncate text-sm font-mono text-text-primary" title={shell?.command}>
            {shell?.command || "Background command"}
          </span>
          {status === "running" && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-500">
              <Loader2 className="size-3 animate-spin" /> live
            </span>
          )}
          {status === "stopping" && <span className="text-[11px] text-warning">stopping…</span>}
          {status === "stopped" && <span className="text-[11px] text-text-subtle">stopped</span>}
          <button
            type="button"
            onClick={closePanel}
            className="flex items-center justify-center size-9 -mr-1 rounded hover:bg-surface-elevated text-text-secondary"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        <pre
          ref={preRef}
          className="flex-1 overflow-auto p-4 text-xs font-mono whitespace-pre-wrap break-words text-text-primary bg-background"
        >
          {error ? `Failed to read output: ${error}` : content || (loading ? "Loading…" : "(no output yet)")}
        </pre>
      </div>
    </div>
  );
}
