/**
 * Choosing a workflow for a new chat (Kiro's "Start with a workflow"): Chat, Spec, Quick Spec or
 * Bug Fix, plus where a Spec starts and its task checks. The welcome screen shows the cards, the
 * composer's Modes menu a Workflow group and, while one is on, a chip; all read and write the one
 * choice the chat tab holds, through this context.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Bug, Check, ChevronDown, ClipboardList, FlaskConical, Loader2, MessageSquare, Zap } from "@/lib/icons";
import type { ChatWorkflow, SpecStartChoice } from "@/lib/api-specs";

export interface SpecWorkflowState {
  choice: SpecStartChoice;
  setChoice: (next: SpecStartChoice) => void;
  /** The chat already exists: its workflow is shown, not chosen. */
  locked: boolean;
  /** The spec this chat is bound to, when it has one. */
  boundTitle: string | null;
  boundChecks: "standard" | "thorough" | null;
  /** Shows or hides the spec beside the chat. */
  onTogglePane?: () => void;
  paneOpen?: boolean;
  /** A chat that already exists and has no spec: start one bound to it (the AI is told on its next message). */
  onStartHere?: (choice: SpecStartChoice) => Promise<void>;
}

export const SpecWorkflowContext = createContext<SpecWorkflowState | null>(null);

const WORKFLOWS: Array<{ id: ChatWorkflow; label: string; note: string; Icon: typeof MessageSquare }> = [
  { id: "chat", label: "Chat", note: "Talk it through. No documents.", Icon: MessageSquare },
  { id: "spec", label: "Spec", note: "Requirements, design, tasks — you approve each step.", Icon: ClipboardList },
  { id: "quick", label: "Quick Spec", note: "All three documents in one go, no stops.", Icon: Zap },
  { id: "bugfix", label: "Bug Fix", note: "What happens, what should, what must not change.", Icon: Bug },
];

const label = (w: ChatWorkflow) => WORKFLOWS.find((x) => x.id === w)!.label;

/** The welcome screen's cards and, for a spec workflow, its two options. */
export function SpecWorkflowCards() {
  const ctx = useContext(SpecWorkflowContext);
  if (!ctx || ctx.locked) return null;
  const { choice, setChoice } = ctx;
  return (
    <div className="flex w-full max-w-3xl flex-col items-center gap-3 px-4" data-spec-workflows="">
      <div className="text-center">
        <div className="text-base font-semibold text-text">What are we building?</div>
        <div className="text-xs text-text-subtle">Start with a workflow, or just chat.</div>
      </div>
      <div className="grid w-full grid-cols-2 gap-2 md:grid-cols-4" role="radiogroup" aria-label="Workflow">
        {WORKFLOWS.map(({ id, label: name, note, Icon }) => {
          const on = choice.workflow === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setChoice({ ...choice, workflow: id })}
              className={`flex min-h-11 flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors ${on ? "border-primary bg-accent-wash" : "border-border bg-panel hover:bg-surface-hover"}`}
            >
              <span className={`flex size-7 items-center justify-center rounded-lg ${on ? "bg-primary text-primary-foreground" : "bg-panel-2 text-text-2"}`}><Icon className="size-4" /></span>
              <span className="text-sm font-medium text-text">{name}</span>
              <span className="text-[11.5px] leading-snug text-text-3">{note}</span>
            </button>
          );
        })}
      </div>
      {choice.workflow !== "chat" && <SpecOptions />}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T; options: Array<{ id: T; label: React.ReactNode; title?: string }>; onChange: (v: T) => void; ariaLabel: string;
}) {
  return (
    <div className="flex shrink-0 rounded-md border border-border p-0.5 text-xs" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} title={o.title} onClick={() => onChange(o.id)}
          className={`inline-flex h-7 items-center gap-1 rounded px-2.5 ${value === o.id ? "bg-accent-wash text-primary" : "text-text-2 hover:bg-surface-hover"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SpecOptions() {
  const { choice, setChoice } = useContext(SpecWorkflowContext)!;
  return (
    <div className="flex w-full flex-col gap-2 rounded-xl border border-border-soft bg-panel p-3">
      {choice.workflow === "spec" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-24 shrink-0 text-xs text-text-2">Start from</span>
          <Segmented ariaLabel="Start from" value={choice.startFrom} onChange={(startFrom) => setChoice({ ...choice, startFrom })}
            options={[{ id: "requirements", label: "Requirements" }, { id: "design", label: "Design" }]} />
          <span className="min-w-0 flex-1 text-[11.5px] text-text-3">Design first suits work that starts from a technical constraint.</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 shrink-0 text-xs text-text-2">Task checks</span>
        <Segmented ariaLabel="Task checks" value={choice.checks} onChange={(checks) => setChoice({ ...choice, checks })}
          options={[
            { id: "standard", label: "Standard", title: "The AI marks tasks done; PPM runs no tests." },
            { id: "thorough", label: <><FlaskConical className="size-3.5 text-success" />Thorough</> },
          ]} />
        <span className="min-w-0 flex-1 text-[11.5px] text-text-3">
          {choice.checks === "thorough"
            ? <>PPM runs your tests: each task must <b className="font-medium text-error">fail</b> first, then <b className="font-medium text-success">pass</b>. The AI can't tick a task itself.</>
            : "The AI marks each task done. You can switch to Thorough later."}
        </span>
      </div>
    </div>
  );
}

/**
 * The Workflow group under the permission modes (the composer's Modes menu). A workflow is chosen
 * alongside a mode, never instead of one: Spec with Bypass is an ordinary combination. A new chat
 * picks it for its first message, a chat with no spec can start one bound to itself, and a chat
 * bound to a spec shows it.
 */
export function SpecWorkflowMenuSection({ onDone }: { onDone: () => void }) {
  const ctx = useContext(SpecWorkflowContext);
  const [starting, setStarting] = useState<ChatWorkflow | null>(null);
  if (!ctx) return null;
  const { choice, setChoice, locked, boundTitle, boundChecks, onTogglePane, paneOpen, onStartHere } = ctx;
  if (locked && !boundTitle && !onStartHere) return null;

  const heading = (
    <div className="flex items-center justify-between border-t border-border px-3 pb-1 pt-2">
      <span className="text-xs font-medium text-text-secondary">Workflow</span>
    </div>
  );

  if (locked && boundTitle) {
    return (
      <div>
        {heading}
        <button type="button" onClick={() => { onTogglePane?.(); onDone(); }}
          className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-elevated focus:bg-surface-elevated focus:outline-none">
          <ClipboardList className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-text-primary">Spec: {boundTitle}</span>
            <span className="block text-xs text-text-subtle">{boundChecks === "thorough" ? "Thorough — PPM runs the tests" : "Standard"} · {paneOpen ? "Hide the spec" : "Show the spec"}</span>
          </span>
          {boundChecks === "thorough" && <FlaskConical className="size-4 shrink-0 text-success" />}
        </button>
      </div>
    );
  }

  const pick = async (id: ChatWorkflow) => {
    const next = { ...choice, workflow: id };
    if (!locked) { setChoice(next); onDone(); return; }
    if (id === "chat" || !onStartHere) return;
    setStarting(id);
    try {
      await onStartHere(next);
      onDone();
    } finally {
      setStarting(null);
    }
  };
  const current: ChatWorkflow = locked ? "chat" : choice.workflow;
  return (
    <div>
      {heading}
      {locked && <div className="px-3 pb-1 text-[11px] text-text-subtle">Turn this chat into a spec. The AI picks it up with your next message.</div>}
      {WORKFLOWS.map(({ id, label: name, note, Icon }) => {
        const on = current === id;
        return (
          <button key={id} type="button" role="option" aria-selected={on} disabled={!!starting || (locked && id === "chat")}
            onClick={() => void pick(id)}
            className={`flex min-h-11 w-full items-start gap-3 px-3 py-2 text-left hover:bg-surface-elevated focus:bg-surface-elevated focus:outline-none disabled:cursor-default ${on ? "bg-surface-elevated" : ""}`}>
            <Icon className="mt-0.5 size-4 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-text-primary">{name}</span>
              <span className="block text-xs leading-snug text-text-subtle">{note}</span>
            </span>
            {starting === id ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" /> : on && <Check className="mt-0.5 size-4 shrink-0 text-primary" />}
          </button>
        );
      })}
      {(locked || current !== "chat") && (
        <div className="flex items-center gap-2 border-t border-border-soft px-3 py-2">
          <span className="flex-1 text-xs text-text-2">Task checks</span>
          <Segmented ariaLabel="Task checks" value={choice.checks} onChange={(checks) => setChoice({ ...choice, checks })}
            options={[
              { id: "standard", label: "Standard", title: "The AI marks tasks done; PPM runs no tests." },
              { id: "thorough", label: <><FlaskConical className="size-3.5 text-success" />Thorough</>, title: "PPM runs the tests: each task must fail first, then pass." },
            ]} />
        </div>
      )}
    </div>
  );
}

/**
 * The composer's workflow chip, shown only while a workflow is on: the spec this chat is bound to
 * (toggles its pane), or the workflow a new chat will start in. Choosing one is in the Modes menu.
 */
export function SpecWorkflowChip() {
  const ctx = useContext(SpecWorkflowContext);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!ctx) return null;
  const { choice, setChoice, locked, boundTitle, boundChecks, onTogglePane } = ctx;

  // A chat bound to a spec: the chip shows the spec and toggles its pane.
  if (locked) {
    if (!boundTitle) return null;
    return (
      <button type="button" onClick={onTogglePane} title={`Spec: ${boundTitle} — show or hide it`}
        className="inline-flex h-[30px] max-w-40 items-center gap-1.5 rounded-full bg-accent-wash px-[9px] text-[11.5px] text-primary">
        <ClipboardList className="size-4 shrink-0" /><span className="truncate">Spec</span>
        {boundChecks === "thorough" && <FlaskConical className="size-3 shrink-0 text-success" />}
      </button>
    );
  }
  const on = choice.workflow !== "chat";
  if (!on) return null;
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} title={`Workflow: ${label(choice.workflow)}${on ? ` · ${choice.checks === "thorough" ? "Thorough" : "Standard"}` : ""}`}
        className={`inline-flex h-[30px] items-center gap-1.5 rounded-full px-[9px] text-[11.5px] ${on ? "bg-accent-wash text-primary" : "text-text-2 hover:bg-surface-hover"}`}
        aria-haspopup="listbox" aria-expanded={open}>
        {(() => { const W = WORKFLOWS.find((x) => x.id === choice.workflow)!; return <W.Icon className="size-4" />; })()}
        <span className="max-md:hidden">{label(choice.workflow)}</span>
        {on && choice.checks === "thorough" && <FlaskConical className="size-3 text-success" />}
        <ChevronDown className="size-3 text-text-3" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-64 rounded-lg border border-border bg-panel p-1 shadow-lg" role="listbox">
          {WORKFLOWS.map(({ id, label: name, note, Icon }) => (
            <button key={id} type="button" role="option" aria-selected={choice.workflow === id}
              onClick={() => { setChoice({ ...choice, workflow: id }); setOpen(false); }}
              className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${choice.workflow === id ? "bg-accent-wash" : "hover:bg-surface-hover"}`}>
              <Icon className="mt-0.5 size-4 shrink-0 text-text-2" />
              <span><span className="block text-xs font-medium text-text">{name}</span><span className="block text-[11px] text-text-3">{note}</span></span>
            </button>
          ))}
          {on && (
            <div className="mt-1 border-t border-border-soft px-2 pb-1 pt-2">
              <Segmented ariaLabel="Task checks" value={choice.checks} onChange={(checks) => setChoice({ ...choice, checks })}
                options={[{ id: "standard", label: "Standard" }, { id: "thorough", label: <><FlaskConical className="size-3.5 text-success" />Thorough</> }]} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
