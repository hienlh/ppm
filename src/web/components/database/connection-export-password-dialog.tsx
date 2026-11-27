/**
 * PPM's password, typed before every saved connection leaves the machine with its credentials in
 * plain text. The server checks it; a wrong one keeps the dialog open with the server's words.
 * A dialog on a desktop, a bottom sheet on a phone.
 */
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/hooks/use-is-mobile";

const TITLE = "Export connections?";
const EXPLANATION = "The export holds every saved password, in plain text. Type PPM's password to confirm it is you.";

export function ConnectionExportPasswordDialog({ onCancel, onConfirm }: {
  onCancel: () => void;
  /** Runs the export; a rejection is shown here and the dialog stays open. */
  onConfirm: (ppmPassword: string) => Promise<void>;
}) {
  const isMobile = useIsMobile();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const body = (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!password || busy) return;
        setBusy(true);
        setError(null);
        try {
          await onConfirm(password);
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <Input
        type="password" autoComplete="current-password" placeholder="PPM password" aria-label="PPM password"
        value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} autoFocus className="h-11 md:h-9"
      />
      {error && <p role="alert" className="text-xs text-error">{error}</p>}
      <div className="flex flex-col-reverse gap-2 pt-1 md:flex-row md:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} className="min-h-11 md:min-h-9">Cancel</Button>
        <Button type="submit" disabled={!password || busy} className="min-h-11 md:min-h-9">Export</Button>
      </div>
    </form>
  );
  if (isMobile) {
    return (
      <BottomSheet open onClose={onCancel}>
        <div className="space-y-3 px-4 pb-4" role="dialog" aria-label={TITLE}>
          <h2 className="text-base font-semibold">{TITLE}</h2>
          <p className="text-sm text-text-secondary">{EXPLANATION}</p>
          {body}
        </div>
      </BottomSheet>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{TITLE}</DialogTitle>
          <DialogDescription>{EXPLANATION}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
