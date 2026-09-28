import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Trash2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { DesignResponsiveDialog } from "../dialogs/design-responsive-dialog";
import { COMMENT_LIMITS } from "../../../../shared/design-comment-types";

/**
 * Writing a comment on an element, editing one, or adding a note to "Send to AI" for a
 * single element. The element's text and markup are shown as plain text: both come from the
 * page and are never rendered as HTML.
 */

export interface ComposerTarget {
  mode: "create" | "edit" | "send";
  tag: string;
  /** The element's text as the page reported it (or as the comment stored it). */
  text: string;
  /** The page's markup for the element, shown for orientation only. */
  markup?: string;
  initialBody?: string;
}

const TITLES: Record<ComposerTarget["mode"], (tag: string) => string> = {
  create: (tag) => `Comment on <${tag}>`,
  edit: () => "Comment",
  send: (tag) => `Send <${tag}> to AI`,
};

export function CommentComposer({ target, onClose, onSubmit, onDelete }: {
  target: ComposerTarget | null;
  onClose: () => void;
  /** Resolves when done; a rejection keeps the dialog open with the text intact. */
  onSubmit: (body: string) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setBody(target?.initialBody ?? "");
    setBusy(false);
    if (target) requestAnimationFrame(() => inputRef.current?.focus());
  }, [target]);

  if (!target) return null;
  const sending = target.mode === "send";
  const canSubmit = !busy && body.length <= COMMENT_LIMITS.body && (sending || body.trim().length > 0);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      toast.error("That did not work", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DesignResponsiveDialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={TITLES[target.mode](target.tag)}
      description={sending ? "Add a note if you like. You will see the whole message before it goes into the chat." : undefined}
      footer={<>
        {target.mode === "edit" && onDelete && (
          <Button variant="outline" className="text-destructive md:mr-auto" disabled={busy} onClick={() => run(onDelete)}>
            <Trash2 className="size-4" /> Delete
          </Button>
        )}
        <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button disabled={!canSubmit} onClick={() => run(() => onSubmit(body))}>
          {busy && <Loader2 className="size-4 animate-spin" />} {sending ? "Preview message" : "Save"}
        </Button>
      </>}
    >
      <div className="flex flex-col gap-3">
        {target.text && (
          <blockquote className="line-clamp-4 border-l-2 border-border pl-3 text-sm text-text-2">{target.text}</blockquote>
        )}
        {target.markup && (
          <details className="text-xs text-text-subtle">
            <summary className="min-h-11 cursor-pointer py-2 md:min-h-0 md:py-0">Markup</summary>
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-elevated p-2 font-mono">{target.markup}</pre>
          </details>
        )}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-2">{sending ? "Note (optional)" : "Comment"}</span>
          <textarea
            ref={inputRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) void run(() => onSubmit(body)); }}
            maxLength={COMMENT_LIMITS.body}
            rows={4}
            placeholder={sending ? "What should change?" : "What should change here?"}
            className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
          <span className="self-end text-xs text-text-subtle">{body.length}/{COMMENT_LIMITS.body}</span>
        </label>
      </div>
    </DesignResponsiveDialog>
  );
}
