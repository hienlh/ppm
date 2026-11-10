/**
 * The spec beside its chat: where it stands (Requirements → Design → Tasks), the document of the
 * step you are on with Approve / Request changes, and once the tasks are approved the tasks by
 * wave with Run all, Start and each task chat. Approvals are made here (or with `ppm spec
 * approve`) and nowhere else; the chat's AI only submits.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Check, CheckCircle2, ChevronRight, ClipboardList, FileCode, FlaskConical, Loader2, Palette, Pencil, X,
} from "@/lib/icons";
import { MarkdownRenderer } from "@/components/shared/markdown-renderer";
import { specsApi } from "@/lib/api-specs";
import { useSpec } from "@/hooks/use-spec";
import { useTabStore } from "@/stores/tab-store";
import { openDesignTab } from "@/lib/design/open-design-tab";
import type { SpecView } from "../../../shared/spec-view";
import type { SpecPhase } from "../../../shared/spec-types";
import { SpecTasks } from "./spec-tasks";

const PHASE_LABEL: Record<SpecPhase, string> = { requirements: "Requirements", design: "Design", tasks: "Tasks" };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The templates' `<!-- … -->` notes are for the AI, and with raw HTML off they would show as
 * text; code blocks are left as written.
 */
export function withoutHtmlComments(markdown: string): string {
  return markdown.split(/(^```[\s\S]*?^```)/m).map((part, i) => (i % 2 ? part : part.replace(/<!--[\s\S]*?-->\n?/g, ""))).join("");
}

export function SpecPane({ projectName, slug, onClose, state }: {
  projectName: string;
  slug: string;
  onClose?: () => void;
  /** The spec as the host already loads it; the pane loads it itself otherwise. */
  state?: ReturnType<typeof useSpec>;
}) {
  const own = useSpec(projectName, state ? null : slug);
  const { spec, error, setSpec } = state ?? own;

  // The AI called spec_open_design: show the drawing it is about to make.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ projectName?: string; slug?: string; designSlug?: string }>).detail;
      if (d?.projectName === projectName && d.slug === slug && d.designSlug) openDesignTab({ projectName, slug: d.designSlug });
    };
    window.addEventListener("spec:open-design", onOpen);
    return () => window.removeEventListener("spec:open-design", onOpen);
  }, [projectName, slug]);
  // Which document is shown: the step you are on unless you picked another.
  const [picked, setPicked] = useState<SpecPhase | null>(null);

  if (!spec) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-subtle" role="status">
        {error ? <span className="px-4 text-center">Could not load the spec: {error}</span> : <><Loader2 className="size-4 animate-spin" /> Loading spec…</>}
      </div>
    );
  }
  const shown: SpecPhase | "tasks-list" = picked ?? (spec.current === "execution" ? "tasks-list" : spec.current);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel" data-spec-pane="">
      <SpecHeader spec={spec} projectName={projectName} onUpdate={setSpec} onClose={onClose} />
      <SpecStepper spec={spec} shown={shown} onPick={(p) => setPicked(p === picked ? null : p)} />
      {shown === "tasks-list" || (shown === "tasks" && spec.current === "execution")
        ? <SpecTasks spec={spec} projectName={projectName} onUpdate={setSpec} onShowDoc={() => setPicked("tasks")} />
        : <SpecDocument spec={spec} phase={shown} projectName={projectName} onUpdate={setSpec} onBackToTasks={spec.current === "execution" ? () => setPicked(null) : undefined} />}
    </div>
  );
}

function SpecHeader({ spec, projectName, onUpdate, onClose }: { spec: SpecView; projectName: string; onUpdate: (v: SpecView) => void; onClose?: () => void }) {
  const [busy, setBusy] = useState(false);
  const setChecks = async (checks: "standard" | "thorough") => {
    if (checks === spec.checks || busy) return;
    setBusy(true);
    try {
      onUpdate(await specsApi.setChecks(projectName, spec.slug, checks));
    } catch (e) {
      toast.error("Could not change the checks", { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const kind = spec.kind === "bugfix" ? "Bug fix" : spec.kind === "quick" ? "Quick spec" : "Feature";
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-soft px-3">
      <ClipboardList className="size-4 shrink-0 text-primary" />
      <span className="truncate text-sm font-semibold" title={spec.folder}>{spec.title}</span>
      <span className="shrink-0 rounded-full bg-panel-2 px-2 py-0.5 text-[11px] text-text-3">{kind}</span>
      <span className="min-w-0 flex-1" />
      <span className="shrink-0 text-[11px] text-text-3 max-md:hidden">Task checks</span>
      <div className="flex shrink-0 rounded-md border border-border p-0.5 text-xs" role="radiogroup" aria-label="Task checks">
        {(["standard", "thorough"] as const).map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={spec.checks === c}
            disabled={busy}
            onClick={() => void setChecks(c)}
            title={c === "thorough" ? "PPM runs the tests: each task must fail first, then pass. The AI cannot tick a task itself." : "The AI marks tasks done; PPM runs no tests."}
            className={`inline-flex h-6 items-center gap-1 rounded px-2 ${spec.checks === c ? "bg-accent-wash text-primary" : "text-text-2 hover:bg-surface-hover"}`}
          >
            {c === "thorough" && <FlaskConical className="size-3.5 text-success" />}
            {c === "standard" ? "Standard" : "Thorough"}
          </button>
        ))}
      </div>
      {onClose && (
        <button type="button" onClick={onClose} className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-surface-hover" aria-label="Hide the spec" title="Hide the spec">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

function SpecStepper({ spec, shown, onPick }: { spec: SpecView; shown: string; onPick: (p: SpecPhase) => void }) {
  const done = spec.tasks.filter((t) => !t.optional && t.done).length;
  const total = spec.tasks.filter((t) => !t.optional).length;
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border-soft px-2">
      {spec.order.map((p, i) => {
        const ph = spec.phases[p];
        const approved = ph.status === "approved";
        const now = spec.current === p;
        return (
          <span key={p} className="flex shrink-0 items-center">
            {i > 0 && <ChevronRight className="mx-0.5 size-3 text-text-3" />}
            <button
              type="button"
              onClick={() => onPick(p)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs ${shown === p ? "bg-accent-wash text-primary" : now ? "text-text font-medium" : "text-text-2"} hover:bg-surface-hover`}
              title={`${ph.file}: ${ph.submitted ? "waiting for your approval" : ph.status}`}
            >
              {approved
                ? <CheckCircle2 className="size-4 text-success" />
                : <span className={`flex size-4 items-center justify-center rounded-full text-[10px] ${now ? "bg-primary text-primary-foreground" : "bg-panel-2 text-text-3"}`}>{i + 1}</span>}
              {PHASE_LABEL[p]}
              {ph.status === "stale" && <span className="text-warning" title="Changed after it was approved">•</span>}
              {ph.submitted && <span className="size-1.5 rounded-full bg-warning" aria-label="waiting for you" />}
            </button>
          </span>
        );
      })}
      {spec.needsDrawing && (
        <span className={`ml-1 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${spec.drawing === "approved" ? "bg-success/15 text-success" : "bg-info/15 text-info"}`} title="UI: yes — the design step includes a drawing">
          <Palette className="size-3" />Drawing: {spec.drawing}
        </span>
      )}
      <span className="min-w-2 flex-1" />
      {spec.current === "execution" && total > 0 && (
        <span className="flex shrink-0 items-center gap-2 text-[11.5px] tabular-nums text-text-2">
          {done} of {total} done
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-border"><span className="block h-full bg-success" style={{ width: `${Math.round((done / total) * 100)}%` }} /></span>
        </span>
      )}
    </div>
  );
}

function SpecDocument({ spec, phase, projectName, onUpdate, onBackToTasks }: {
  spec: SpecView; phase: SpecPhase; projectName: string; onUpdate: (v: SpecView) => void; onBackToTasks?: () => void;
}) {
  const ph = spec.phases[phase];
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const errors = ph.issues.filter((i) => i.severity === "error");
  const warnings = ph.issues.filter((i) => i.severity === "warning");
  const canAct = ph.status === "draft" || ph.status === "stale";
  const openFile = () => useTabStore.getState().openTab({
    type: "editor", title: ph.file.split("/").pop() ?? ph.file, projectId: projectName,
    metadata: { projectName, filePath: ph.file }, closable: true,
  });

  const approve = async () => {
    setBusy(true);
    try {
      const r = await specsApi.approve(projectName, spec.slug, phase);
      onUpdate(r.spec);
      toast.success(r.message);
    } catch (e) {
      toast.error("Not approved", { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const sendNote = async () => {
    if (!note.trim()) return;
    setBusy(true);
    try {
      onUpdate(await specsApi.requestChanges(projectName, spec.slug, phase, note.trim()));
      setNote("");
      setNoteOpen(false);
      toast.success("Sent to the chat");
    } catch (e) {
      toast.error("Could not send", { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-soft px-3 text-xs">
        <button type="button" onClick={openFile} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-text-2 hover:bg-surface-hover" title="Open in the editor">
          <FileCode className="size-3.5" />{ph.file}
        </button>
        <span className="flex-1" />
        {onBackToTasks && <button type="button" onClick={onBackToTasks} className="h-7 rounded-md px-2 text-primary hover:bg-surface-hover">Back to tasks</button>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {(errors.length > 0 || warnings.length > 0) && (
          <div className="mb-3 space-y-1 rounded-md border border-border-soft bg-panel-2 p-2 text-xs">
            {errors.map((i, k) => <div key={`e${k}`} className="text-error">Line {i.line}: {i.message}</div>)}
            {warnings.slice(0, 6).map((i, k) => <div key={`w${k}`} className="text-warning">Line {i.line}: {i.message}</div>)}
          </div>
        )}
        {ph.text === null
          ? <p className="text-sm text-text-subtle">Not written yet. The AI writes {ph.file} when it gets to this step.</p>
          : <MarkdownRenderer content={withoutHtmlComments(ph.text)} projectName={projectName} rawHtml={false} />}
      </div>
      {noteOpen && (
        <div className="shrink-0 border-t border-border-soft p-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            autoFocus
            placeholder={`What should change in ${ph.file}?`}
            className="w-full resize-none rounded-md border border-border bg-background p-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void sendNote(); }}
          />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setNoteOpen(false)} className="h-8 rounded-md px-3 text-xs text-text-2 hover:bg-surface-hover">Cancel</button>
            <button type="button" disabled={busy || !note.trim()} onClick={() => void sendNote()} className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50">Send to the chat</button>
          </div>
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border-soft px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-3">
          {ph.status === "approved" ? "Approved" : ph.status === "stale" ? "Changed after you approved it" : ph.submitted ? "Submitted by the AI · waiting for you" : ph.status === "invalid" ? "Has problems the AI must fix" : ph.status === "missing" ? "Not written yet" : "Draft · not submitted yet"}
        </span>
        {spec.needsDrawing && spec.designSlug && (phase === "design" || phase === "requirements") && (
          <button type="button" onClick={() => openDesignTab({ projectName, slug: spec.designSlug! })} className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-primary hover:bg-panel-2">
            <Palette className="size-3.5" />Open drawing
          </button>
        )}
        {spec.needsDrawing && phase === "design" && spec.drawing !== "approved" && spec.designSlug && (
          <ApproveDrawingButton spec={spec} projectName={projectName} onUpdate={onUpdate} />
        )}
        {canAct && !noteOpen && (
          <button type="button" onClick={() => setNoteOpen(true)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-text hover:bg-panel-2">
            <Pencil className="size-3.5" />Request changes
          </button>
        )}
        {canAct && (
          <button type="button" disabled={busy} onClick={() => void approve()} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}Approve {PHASE_LABEL[phase].toLowerCase()}
          </button>
        )}
      </div>
    </>
  );
}

function ApproveDrawingButton({ spec, projectName, onUpdate }: { spec: SpecView; projectName: string; onUpdate: (v: SpecView) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await specsApi.approve(projectName, spec.slug, "drawing");
          onUpdate(r.spec);
        } catch (e) {
          toast.error("Not approved", { description: errorText(e) });
        } finally {
          setBusy(false);
        }
      }}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-text hover:bg-panel-2"
    >
      <Palette className="size-3.5" />Approve drawing
    </button>
  );
}
