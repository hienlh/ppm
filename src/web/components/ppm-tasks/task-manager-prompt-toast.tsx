/**
 * "Tell the manager now?" on a desktop: a small toast anchored bottom-right that never blocks the
 * page. Any task view hands a write's answer to `offerTaskManagerPrompt`; the one mounted host
 * (`TaskManagerPromptHost`, first mounted wins, as the sidebar and the task tab both mount one)
 * runs P3's `usePpmTaskManagerPrompt`, which asks once per burst of edits. Tell now wakes the
 * manager; Next turn or closing it leaves the news for the manager's next turn. Below `md` the
 * question is a bottom sheet instead (`mobile/task-manager-prompt-sheet.tsx`).
 */
import { useEffect, useId, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Bot, X } from "@/lib/icons";
import { usePpmTaskManagerPrompt } from "@/hooks/use-ppm-task-manager-prompt";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { TaskManagerPromptSheet } from "./mobile/task-manager-prompt-sheet";
import type { TaskWriteResponse } from "../../../shared/ppm-tasks-api";

const OFFER_EVENT = "ppm-tasks:manager-prompt-offer";

type Offer = (Pick<TaskWriteResponse, "managerPrompt"> & { task: { project: string } }) | null;

/** Hands a write's answer to the prompt host (a stale write's null asks nothing). */
export function offerTaskManagerPrompt(answer: Offer): void {
  if (!answer?.managerPrompt || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<Offer>(OFFER_EVENT, { detail: answer }));
}

// The mounted hosts, oldest first; only the first one listens and draws.
const hosts: string[] = [];
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

function useIsLeader(id: string): boolean {
  useEffect(() => {
    hosts.push(id);
    notify();
    return () => {
      const i = hosts.indexOf(id);
      if (i >= 0) hosts.splice(i, 1);
      notify();
    };
  }, [id]);
  return useSyncExternalStore(subscribe, () => hosts[0] === id, () => false);
}

export function TaskManagerPromptHost() {
  const id = useId();
  const leader = useIsLeader(id);
  return leader ? <LeaderHost /> : null;
}

function LeaderHost() {
  const { asking, sending, offer, answer } = usePpmTaskManagerPrompt();
  const isMobile = useIsMobile();
  useEffect(() => {
    const on = (e: Event) => offer((e as CustomEvent<Offer>).detail);
    window.addEventListener(OFFER_EVENT, on);
    return () => window.removeEventListener(OFFER_EVENT, on);
  }, [offer]);
  if (!asking) return null;
  if (isMobile) return <TaskManagerPromptSheet project={asking} sending={sending} onAnswer={(yes) => void answer(yes)} />;
  return createPortal(<TaskManagerPromptToast project={asking} sending={sending} onAnswer={(yes) => void answer(yes)} />, document.body);
}

export interface TaskManagerPromptToastProps {
  project: string;
  sending: boolean;
  onAnswer(yes: boolean): void;
}

/** The toast itself, props only. */
export function TaskManagerPromptToast({ project, sending, onAnswer }: TaskManagerPromptToastProps) {
  return (
    <div role="status" aria-live="polite" data-task-manager-prompt={project}
      className="fixed bottom-4 right-4 z-50 w-[min(340px,calc(100vw-2rem))] rounded-lg border border-border bg-surface-elevated p-3 text-sm shadow-[0_8px_24px_rgba(0,0,0,.25)] max-md:bottom-[calc(1rem+env(safe-area-inset-bottom))]">
      <div className="flex items-start gap-2">
        <Bot aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-2" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-text">Tell the {project} manager now?</p>
          <p className="mt-0.5 text-xs text-text-3">Otherwise it reads your changes on its next turn.</p>
        </div>
        <button type="button" aria-label="Next turn" title="Next turn" disabled={sending} onClick={() => onAnswer(false)}
          className="-m-1 grid size-7 shrink-0 place-items-center rounded-md text-text-3 hover:bg-surface hover:text-text max-md:size-11">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="mt-2.5 flex justify-end gap-2">
        <button type="button" disabled={sending} onClick={() => onAnswer(false)}
          className="h-8 rounded-md border border-border px-3 text-xs text-text-2 hover:text-text disabled:opacity-60 max-md:h-11">
          Next turn
        </button>
        <button type="button" disabled={sending} onClick={() => onAnswer(true)}
          className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 max-md:h-11">
          {sending ? "Telling…" : "Tell now"}
        </button>
      </div>
    </div>
  );
}
