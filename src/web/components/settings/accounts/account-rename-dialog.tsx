/**
 * Give an account a name of its own.
 *
 * Bottom sheet below `md`, centered dialog above — the same adaptive shell as the delete
 * confirmation. Mostly needed for tokens pasted from `claude setup-token`: they cannot read
 * the profile that would otherwise name the account, so two of them look identical.
 */

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "@/lib/icons";
import { useIsMobile } from "@/hooks/use-is-mobile";

/** Mirrors ACCOUNT_LABEL_MAX on the server, which is what actually enforces it. */
const LABEL_MAX = 80;

export function AccountRenameDialog({ current, onSave, onCancel }: {
  current: string;
  /** Rejects with the server's message, which the dialog shows and stays open for. */
  onSave: (label: string) => Promise<void>;
  onCancel: () => void;
}) {
  const isMobile = useIsMobile();
  const [name, setName] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const canSave = !!trimmed && trimmed !== current && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (e) {
      setError((e as Error).message || "Could not rename the account");
      setSaving(false);
    }
  };
  const cancel = () => { if (!saving) onCancel(); };

  const body = (
    <form
      className="space-y-4"
      data-testid="account-rename-dialog"
      onSubmit={(e) => { e.preventDefault(); void save(); }}
    >
      <Input
        autoFocus
        value={name}
        maxLength={LABEL_MAX}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Personal, Work"
        aria-label="Account name"
        className="min-h-11 text-sm md:min-h-9"
      />
      {error && <p className="text-xs text-error" role="alert">{error}</p>}
      <div className="flex flex-col-reverse md:flex-row gap-2 md:justify-end">
        <Button type="button" variant="outline" onClick={cancel} disabled={saving} className="min-h-11 md:min-h-9">
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave} className="min-h-11 md:min-h-9">
          {saving && <Loader2 className="size-4 animate-spin" />} Save
        </Button>
      </div>
    </form>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={cancel}>
        <div className="px-4 pb-4">
          <h2 className="text-base font-semibold mb-3">Rename account</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) cancel(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Rename account</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
