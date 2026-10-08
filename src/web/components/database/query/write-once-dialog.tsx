/**
 * "Run with write access (once)" on a readonly connection: the script that was refused runs once
 * more with the connection writable, for that run alone, once PPM's password is typed. The server
 * checks the password; a wrong one fails the run and the action is offered again. A dialog on a
 * desktop, a bottom sheet on a phone.
 */
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/hooks/use-is-mobile";

const TITLE = "Run with write access (once)?";

export function WriteOnceDialog({ connectionName, sql, passwordRequired, onCancel, onRun }: {
  connectionName: string;
  sql: string;
  /** PPM signs in with a password; with none set, the server asks for nothing. */
  passwordRequired: boolean;
  onCancel: () => void;
  onRun: (password: string) => void;
}) {
  const isMobile = useIsMobile();
  const [password, setPassword] = useState("");
  const explanation = `${connectionName} is readonly. This runs the script below once with write access; the connection stays readonly afterwards.`;
  const body = (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!passwordRequired || password) onRun(password);
      }}
    >
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-background p-2 font-mono text-xs text-text-secondary">{sql}</pre>
      {passwordRequired && (
        <Input
          type="password" autoComplete="current-password" placeholder="PPM password" aria-label="PPM password"
          value={password} onChange={(e) => setPassword(e.target.value)} autoFocus className="h-11 md:h-9"
        />
      )}
      <div className="flex flex-col-reverse gap-2 pt-1 md:flex-row md:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} className="min-h-11 md:min-h-9">Cancel</Button>
        <Button type="submit" variant="destructive" disabled={passwordRequired && !password} className="min-h-11 md:min-h-9">Run once</Button>
      </div>
    </form>
  );
  if (isMobile) {
    return (
      <BottomSheet open onClose={onCancel}>
        <div className="space-y-3 px-4 pb-4" role="dialog" aria-label={TITLE}>
          <h2 className="text-base font-semibold">{TITLE}</h2>
          <p className="text-sm text-text-secondary">{explanation}</p>
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
          <DialogDescription>{explanation}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
