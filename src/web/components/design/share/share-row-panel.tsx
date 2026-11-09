import type { ReactNode } from "react";
import { Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";

/** The frame of one inline row step: its content, then Cancel and the primary action (lowest on a phone). */
export function Panel({ children, confirm, busy, destructive, onCancel, onConfirm, cancelLabel = "Cancel" }: {
  children: ReactNode;
  confirm?: string;
  busy?: boolean;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm?: () => void;
  cancelLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3 text-sm" data-testid="share-row-panel">
      {children}
      <div className="flex flex-col gap-2 md:flex-row md:justify-end [&>*]:min-h-11 md:[&>*]:min-h-9">
        <Button variant="outline" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
        {confirm && onConfirm && (
          <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />} {confirm}
          </Button>
        )}
      </div>
    </div>
  );
}

export const Check = ({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) => (
  <label className="flex min-h-11 cursor-pointer items-center gap-2 md:min-h-8">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-primary" />
    {label}
  </label>
);
