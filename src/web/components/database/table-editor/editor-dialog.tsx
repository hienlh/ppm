/**
 * The frame every table editor dialog shares: DBGate's modal with its buttons at the bottom,
 * Enter for the first one and Esc to close. What stops a dialog from closing is listed above its
 * buttons once Save was tried, and stays live while it is fixed.
 *
 * Only a desktop gets here — the Structure tab is view only on a phone — so these are dialogs, not
 * bottom sheets.
 */
import type { KeyboardEvent, ReactNode } from "react";
import { ChevronDown } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { inputClass } from "../connection-form/form-controls";

export interface EditorDialogButton {
  label: string;
  onClick: () => void;
  variant?: "default" | "outline" | "destructive";
  disabled?: boolean;
}

export function EditorDialog({ title, description, onClose, onSubmit, problems, buttons, children, wide }: {
  title: string;
  /** Said under the title to screen readers; the fields say the rest. */
  description: string;
  onClose: () => void;
  /** Enter: the dialog's first button. Absent for a dialog that only shows. */
  onSubmit?: () => void;
  /** Shown once Save was tried; empty when nothing is wrong. */
  problems: readonly string[];
  buttons: EditorDialogButton[];
  children: ReactNode;
  wide?: boolean;
}) {
  const keyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing || !onSubmit) return;
    // A focused button answers Enter itself: Remove, Delete, Add column.
    const target = e.target as HTMLElement;
    if (target.closest("button, textarea, [role=menuitem]")) return;
    e.preventDefault();
    onSubmit();
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        onKeyDown={keyDown}
        className={cn("max-h-[calc(100dvh-4rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 p-5", wide ? "sm:max-w-2xl" : "sm:max-w-lg")}
      >
        <DialogHeader>
          <DialogTitle className="text-base break-words">{title}</DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 grid content-start gap-3 overflow-y-auto px-1 py-0.5">{children}</div>
        <div className="grid gap-2">
          {problems.length > 0 && (
            <ul role="alert" className="grid gap-0.5 text-[12.5px] text-error">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {buttons.map((b) => (
              <Button key={b.label} type="button" size="sm" variant={b.variant ?? "outline"} disabled={b.disabled} onClick={b.onClick}>{b.label}</Button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A text field with a list beside it, as DBGate's data type and engine fields are: anything can be
 * typed, and the list only fills the box in.
 */
export function TextWithList({ id, value, onChange, options, disabled, listLabel, mono, invalid, autoFocus }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  disabled?: boolean;
  /** Names the list button: "Choose a data type". */
  listLabel: string;
  mono?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex min-w-0">
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        className={cn(inputClass, "rounded-r-none", mono && "font-mono")}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled || options.length === 0}>
          <button
            type="button"
            aria-label={listLabel}
            title={listLabel}
            className="grid h-[30px] w-8 shrink-0 place-items-center rounded-r-md border border-l-0 border-border bg-surface text-text-subtle can-hover:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-55"
          >
            <ChevronDown className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
          {options.map((o) => (
            <DropdownMenuItem key={o} onSelect={() => onChange(o)} className={cn(mono && "font-mono text-xs")}>{o}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
