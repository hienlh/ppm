/**
 * The small parts the Import/Export tab is drawn with: DBGate's form buttons, its plain checkboxes,
 * the titles over each part, a collapsible section of the right-hand column, and the dialog that
 * shows a row's whole error.
 */
import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SectionHeader } from "../explorer/tree-parts";

/** DBGate's FormStyledButton: Current DB, Upload file, All tables… */
export const formButtonClass =
  "inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[5px] border border-border bg-surface px-2.5 text-xs text-text-primary can-hover:hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50";

/** A box as narrow as the map table's cells leave room for. */
export const cellInputClass =
  "h-[26px] w-full min-w-0 rounded-[5px] border border-border bg-surface px-2 text-xs text-text-primary placeholder:text-text-subtle focus:border-ring focus:outline-none";

export function ConfigTitle({ icon: Icon, children }: { icon: ElementType; children: ReactNode }) {
  return (
    <h3 className="my-2.5 flex items-center justify-center gap-2 text-[17px] font-normal text-text-primary">
      <Icon className="size-5 shrink-0 text-text-2" />
      {children}
    </h3>
  );
}

/** A checkbox with its label beside it, as DBGate's form draws one. */
export function CheckField({ checked, onChange, label, disabled }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex min-w-0 items-center gap-2 text-xs text-text-primary", disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="size-[15px] shrink-0 accent-primary" />
      <span className="min-w-0">{label}</span>
    </label>
  );
}

/** One part of the right-hand column, DBGate's WidgetColumnBarItem: a title that folds it away. */
export function SidePane({ title, collapsed, onToggle, className, children }: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  /** How much of the column it takes while it is open. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className={cn("flex min-h-0 flex-col border-b border-border last:border-b-0", collapsed ? "shrink-0" : className)}>
      <SectionHeader title={title} collapsed={collapsed} onToggle={onToggle} />
      {!collapsed && <div className="flex min-h-0 flex-1 flex-col">{children}</div>}
    </section>
  );
}

/** DBGate's error message dialog: the whole of what a row failed with. */
export function ErrorDialog({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-4rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 p-5 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">{title}</DialogTitle>
          <DialogDescription className="sr-only">The error the row stopped with</DialogDescription>
        </DialogHeader>
        <pre className="min-h-0 overflow-auto rounded-md border border-border bg-panel-2 p-3 font-mono text-xs break-words whitespace-pre-wrap text-text-primary">{message}</pre>
        <div className="flex justify-end">
          <Button type="button" size="sm" variant="outline" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
