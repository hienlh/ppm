/**
 * The label of a vault file: what lists and the AI see in place of its encrypted original name.
 * Choosing a label here hands it to the section, which asks for the tier's password if needed.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DesignResponsiveDialog } from "@/components/design/dialogs/design-responsive-dialog";
import { VAULT_MAX_LABEL_LENGTH, type VaultAttachmentMeta } from "../../../../shared/vault";

export function VaultRenameFileDialog({ file, onClose, onRename }: {
  file: VaultAttachmentMeta;
  onClose: () => void;
  onRename: (label: string) => void;
}) {
  const [label, setLabel] = useState(file.label);
  const clean = label.trim();
  const ready = clean.length > 0 && clean !== file.label;
  const submit = () => {
    if (!ready) return;
    onClose();
    onRename(clean);
  };
  return (
    <DesignResponsiveDialog
      open
      onClose={onClose}
      title="Rename file"
      description="The label is what lists and the AI see. Do not put a secret in it."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!ready} onClick={submit}>Rename</Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Input aria-label="Label" autoFocus autoComplete="off" maxLength={VAULT_MAX_LABEL_LENGTH} value={label}
          onChange={(e) => setLabel(e.target.value)} className="h-11 md:h-9" />
      </form>
    </DesignResponsiveDialog>
  );
}
