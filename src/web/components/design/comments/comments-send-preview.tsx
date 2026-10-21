import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Send } from "@/lib/icons";
import { DesignResponsiveDialog } from "../dialogs/design-responsive-dialog";

/**
 * The whole message "Send to AI" is about to put in the design chat, shown before it goes
 * anywhere. Element context inside it came from the design's files, which an agent wrote,
 * so the user reads what the next agent will read — and may edit it, since the words are
 * theirs to send. Confirming only fills the composer; sending is still the user's own press.
 */

export interface SendPreview {
  text: string;
  label: string;
  /** Comments to stamp as sent once delivered; empty for a single element with no comment. */
  ids: string[];
}

export function CommentsSendPreview({ preview, onCancel, onConfirm }: {
  preview: SendPreview | null;
  onCancel: () => void;
  /** Called with the text as the user left it. */
  onConfirm: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  // A new preview replaces whatever was typed into the last one.
  useEffect(() => { setDraft(preview?.text ?? ""); }, [preview]);
  const edited = !!preview && draft !== preview.text;

  return (
    <DesignResponsiveDialog
      open={!!preview}
      onClose={onCancel}
      title="Put this in the design chat?"
      description="This is the full message, and you can edit it. It lands in the chat's composer as an attachment; nothing is sent until you send it there."
      className="md:max-w-2xl"
      footer={<>
        {edited && <Button variant="ghost" onClick={() => setDraft(preview.text)}>Reset</Button>}
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onConfirm(draft)} disabled={!draft.trim()}><Send className="size-4" /> Put in chat</Button>
      </>}
    >
      {preview && (
        <textarea
          aria-label="Message to put in the design chat"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="block h-[55vh] min-h-40 w-full resize-y rounded-md border border-border bg-surface-elevated p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}
    </DesignResponsiveDialog>
  );
}
