import { Button } from "@/components/ui/button";
import { Send } from "@/lib/icons";
import { DesignResponsiveDialog } from "../dialogs/design-responsive-dialog";

/**
 * The whole message "Send to AI" is about to put in the design chat, shown before it goes
 * anywhere. Element context inside it came from the design's files, which an agent wrote,
 * so the user reads what the next agent will read. Confirming only fills the composer;
 * sending is still the user's own press.
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
  onConfirm: () => void;
}) {
  return (
    <DesignResponsiveDialog
      open={!!preview}
      onClose={onCancel}
      title="Put this in the design chat?"
      description="This is the full message. It lands in the chat's composer as an attachment; nothing is sent until you send it there."
      className="md:max-w-2xl"
      footer={<>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={onConfirm}><Send className="size-4" /> Put in chat</Button>
      </>}
    >
      {preview && (
        <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-surface-elevated p-3 font-mono text-xs leading-relaxed">
          {preview.text}
        </pre>
      )}
    </DesignResponsiveDialog>
  );
}
