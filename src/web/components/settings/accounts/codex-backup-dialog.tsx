/**
 * Export or import the Codex accounts bundle.
 *
 * One dialog for both directions, opened in the mode the user asked for, because the two
 * share the same single input: the password that encrypts the file. Presentational — the
 * pane owns the state and the requests.
 *
 * Mirrors the Claude export/import dialogs; the password is required here rather than
 * defaulted, because a Codex bundle carries whole logins.
 */

import { useRef } from "react";
import { Download, Loader2, Lock, Upload } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CodexBackupDialog({
  mode, onOpenChange, password, onPasswordChange, busy, onExport, onImport, error,
}: {
  /** Null closes the dialog; otherwise the direction it opened in. */
  mode: "export" | "import" | null;
  onOpenChange: (open: boolean) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  busy: boolean;
  onExport: () => void;
  onImport: (file: File) => void;
  error: string | null;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const isExport = mode === "export";

  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-1.5">
            <Lock className="size-4" /> {isExport ? "Export Codex Accounts" : "Import Codex Accounts"}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {isExport
              ? "Writes a password-encrypted file containing each account's login."
              : "Reads a backup file. The password must be the one it was exported with."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="codex-backup-password" className="text-xs">Password</Label>
          <Input
            id="codex-backup-password"
            type="password"
            placeholder={isExport ? "Choose a password" : "Password used for the export"}
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            className="text-xs"
            autoComplete={isExport ? "new-password" : "current-password"}
          />
          <p className="text-[10px] text-muted-foreground">
            A backup holds full logins — keep the file and its password together.
          </p>
        </div>

        {error && <div className="text-[11px] p-2 rounded bg-error/10 text-error">{error}</div>}

        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared so picking the same file twice still fires a change event.
            e.target.value = "";
            if (file) onImport(file);
          }}
        />

        <DialogFooter>
          <Button size="sm" variant="outline" className="text-xs cursor-pointer" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="text-xs cursor-pointer gap-1.5"
            disabled={!password.trim() || busy}
            onClick={() => (isExport ? onExport() : fileInput.current?.click())}
          >
            {busy
              ? <Loader2 className="size-3.5 animate-spin" />
              : isExport ? <Download className="size-3.5" /> : <Upload className="size-3.5" />}
            {isExport ? "Download backup" : "Choose file"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
