import { useEffect, useState, useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
import { Save, Undo2, Loader2, AlertTriangle, Lock } from "lucide-react";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { useAiResourcesStore } from "@/stores/ai-resources-store";
import { readAiResource, writeAiResource, type AiResourceType, type AiResourceScope } from "@/lib/api-ai-resources";
import { ScopeBadge, TYPE_ICON } from "./resource-visuals";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface AiResourceEditorProps {
  metadata?: Record<string, unknown>;
  tabId?: string;
}

export function AiResourceEditor({ metadata }: AiResourceEditorProps) {
  const filePath = metadata?.filePath as string;
  const name = metadata?.name as string;
  const resourceType = (metadata?.resourceType as AiResourceType) ?? "skill";
  const scope = (metadata?.scope as AiResourceScope) ?? "user";
  const readOnly = metadata?.readOnly === true;
  const shadowed = metadata?.shadowed === true;
  const shadowedBy = metadata?.shadowedBy as { name: string; source: string } | null;
  const project = (metadata?.project as string) ?? "";

  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const monacoTheme = useMonacoTheme();
  const contentRef = useRef("");
  const dirty = content !== original;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    readAiResource(filePath, project)
      .then((r) => {
        if (cancelled) return;
        setContent(r.content);
        setOriginal(r.content);
        contentRef.current = r.content;
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filePath, project]);

  const save = useCallback(async () => {
    if (readOnly || saving) return;
    const next = contentRef.current;
    if (next === original) return;
    setSaving(true);
    try {
      await writeAiResource(filePath, next, project);
      setOriginal(next);
      setContent(next);
      toast.success("Saved");
      void useAiResourcesStore.getState().reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [filePath, project, original, readOnly, saving]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const Icon = TYPE_ICON[resourceType];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 shrink-0">
        <Icon className="size-4 text-text-subtle" />
        <span className="text-sm font-semibold">{name}</span>
        <ScopeBadge scope={scope} />
        {dirty && !readOnly && <span className="size-1.5 rounded-full bg-primary" title="Unsaved changes" />}
        <div className="flex-1" />
        <span className="hidden sm:block text-[11px] text-text-subtle">{resourceType} · markdown</span>
        {!readOnly && (
          <>
            <button
              onClick={() => setContent(original)}
              disabled={!dirty || saving}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-elevated disabled:opacity-40"
            >
              <Undo2 className="size-3.5" /> Revert
            </button>
            <button
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save
            </button>
          </>
        )}
      </div>

      {/* Banners */}
      {readOnly && (
        <Banner icon={Lock} tone="muted">
          Bundled resource — read-only. Duplicate it (from the AI Resources panel) to make an editable copy.
        </Banner>
      )}
      {shadowed && shadowedBy && (
        <Banner icon={AlertTriangle} tone="warn">
          This {resourceType} is overridden by another “{shadowedBy.name}” from a higher-priority source
          ({shadowedBy.source}). It is currently inactive.
        </Banner>
      )}

      {/* Editor */}
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : error ? (
          <div className="p-6 text-center text-sm text-destructive">{error}</div>
        ) : (
          <Editor
            height="100%"
            language="markdown"
            theme={monacoTheme}
            value={content}
            onChange={(v) => { const next = v ?? ""; contentRef.current = next; setContent(next); }}
            options={{
              readOnly,
              minimap: { enabled: false },
              fontSize: 13,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              lineNumbers: "on",
            }}
          />
        )}
      </div>
    </div>
  );
}

function Banner({ icon: Icon, tone, children }: { icon: React.ElementType; tone: "warn" | "muted"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 px-3 py-2 text-[12px] shrink-0 border-b border-border",
        tone === "warn" ? "bg-amber-500/10 text-amber-300" : "bg-surface-elevated text-text-secondary",
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
