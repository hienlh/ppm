import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { COMMENT_LIMITS } from "../../../../shared/design-comment-types";

/**
 * The one text box a thread uses for everything typed into it: a reply, a reply being
 * edited, or the owner's own comment being edited. Submitting keeps the text when the server
 * refuses, so nothing typed is lost to an error; Ctrl/Cmd+Enter submits.
 */
export function CommentThreadTextBox({ initial = "", placeholder, submitLabel, onSubmit, onCancel, autoFocus, label }: {
  initial?: string;
  placeholder: string;
  submitLabel: string;
  /** Resolves when saved; a rejection keeps the text. */
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
  label: string;
}) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setBody(initial); }, [initial]);
  useEffect(() => { if (autoFocus) requestAnimationFrame(() => ref.current?.focus()); }, [autoFocus]);

  const canSubmit = !busy && body.trim().length > 0 && body.length <= COMMENT_LIMITS.body;
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setBody("");
    } catch (e) {
      toast.error("That did not work", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={ref}
        aria-label={label}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }}
        maxLength={COMMENT_LIMITS.body}
        rows={2}
        placeholder={placeholder}
        className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      />
      <div className="flex items-center justify-end gap-2">
        {body.length > COMMENT_LIMITS.body * 0.9 && (
          <span className="mr-auto text-xs text-text-subtle">{body.length}/{COMMENT_LIMITS.body}</span>
        )}
        {onCancel && (
          <Button variant="outline" size="sm" className="min-h-11 md:min-h-8" disabled={busy} onClick={onCancel}>Cancel</Button>
        )}
        <Button size="sm" className="min-h-11 md:min-h-8" disabled={!canSubmit} onClick={() => void submit()}>
          {busy && <Loader2 className="size-4 animate-spin" />} {submitLabel}
        </Button>
      </div>
    </div>
  );
}
