/**
 * `/btw <question>`: Claude Code's side question. Claude answers from what the chat already knows,
 * with no tools, even while a turn is running, and neither the question nor the answer joins the
 * conversation. The answer is shown above the composer until closed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { Loader2, MessageCircle, X } from "@/lib/icons";
import { MarkdownContent } from "./message-markdown";

export type SideQuestionState =
  | { status: "asking"; question: string }
  | { status: "answered"; question: string; answer: string | null }
  | { status: "failed"; question: string; error: string };

/** `/btw <question>` → the question; null for anything else. */
export function sideQuestionOf(content: string): string | null {
  const m = content.trim().match(/^\/btw(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return m[1]?.trim() ?? "";
}

export function useSideQuestion(projectName: string | undefined, sessionId: string | null | undefined) {
  const [state, setState] = useState<SideQuestionState | null>(null);
  const ctl = useRef<AbortController | null>(null);

  const close = useCallback(() => {
    ctl.current?.abort();
    ctl.current = null;
    setState(null);
  }, []);

  const ask = useCallback(async (question: string) => {
    if (!projectName || !sessionId) return;
    ctl.current?.abort();
    const mine = new AbortController();
    ctl.current = mine;
    setState({ status: "asking", question });
    try {
      const { response } = await api.post<{ response: string | null }>(
        `${projectUrl(projectName)}/chat/sessions/${encodeURIComponent(sessionId)}/side-question`,
        { question },
        { signal: mine.signal },
      );
      if (ctl.current === mine) setState({ status: "answered", question, answer: response });
    } catch (e) {
      if (ctl.current !== mine || mine.signal.aborted) return;
      setState({ status: "failed", question, error: e instanceof Error ? e.message : "Claude did not answer" });
    }
  }, [projectName, sessionId]);

  // Another chat in the tab: its side answer does not belong here.
  useEffect(() => close, [sessionId, close]);

  return { state, ask, close };
}

export function SideQuestionPanel({ state, projectName, onClose }: {
  state: SideQuestionState;
  projectName?: string;
  onClose: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Side question"
      data-testid="side-question-panel"
      className="mb-2 overflow-hidden rounded-xl border border-border bg-panel-2 text-sm shadow-[var(--shadow-float)]"
    >
      <div className="flex items-start gap-2 border-b border-border-soft px-3 py-2">
        <MessageCircle className="mt-0.5 size-4 shrink-0 text-text-subtle" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-text-subtle">By the way · not added to the chat</div>
          <div className="whitespace-pre-wrap break-words text-text-2">{state.question}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close side question"
          title="Close"
          className="inline-grid size-6 shrink-0 place-items-center rounded-md text-text-subtle hover:bg-surface hover:text-text-primary"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="max-h-[40vh] overflow-y-auto px-3 py-2">
        {state.status === "asking" && (
          <p className="m-0 flex items-center gap-2 text-text-subtle"><Loader2 className="size-3.5 animate-spin" />Asking Claude…</p>
        )}
        {state.status === "answered" && (state.answer
          ? <MarkdownContent content={state.answer} projectName={projectName} />
          : <p className="m-0 text-text-subtle">Claude gave no answer.</p>)}
        {state.status === "failed" && <p role="alert" className="m-0 text-error">{state.error}</p>}
      </div>
    </div>
  );
}
