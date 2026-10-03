/**
 * What every database tab is built from: DBGate's toolstrip and its buttons — one that opens
 * another tab carries a ↗ — the header that names the tab on a phone, and the states a tab shows
 * in place of its content (reading, refused, a driver to install, a connection that is gone).
 */
import type { ElementType, ReactNode } from "react";
import { AlertCircle, ArrowUpRight, Loader2, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { MissingDbDriver } from "@/lib/db-drivers";
import { DriverMissingNotice } from "./driver-missing-notice";

/**
 * DBGate's toolstrip: labels on a desktop, 44px icon buttons in a 52px strip on a phone. Too narrow
 * for its buttons, it scrolls and shows the app's thin scrollbar, which says more is past the edge.
 */
export function DbToolbar({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={cn(
        "flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-background px-2",
        "max-md:h-[52px] max-md:gap-1",
        className,
      )}
    >
      {children}
    </div>
  );
}

export const toolButtonClass = cn(
  "flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-xs text-text-2 can-hover:hover:bg-surface-hover can-hover:hover:text-text-primary",
  "disabled:pointer-events-none disabled:opacity-40",
  "max-md:h-11 max-md:min-w-11 max-md:justify-center max-md:px-2.5",
);

export function DbToolButton({ icon: Icon, label, title, onClick, opensTab, disabled, className, labelClassName = "max-md:hidden", arrowClassName = "max-md:hidden" }: {
  icon: ElementType;
  label: string;
  title?: string;
  onClick: () => void;
  /** Opens another tab: DBGate's ↗, left out on a phone where the label is too. */
  opensTab?: boolean;
  disabled?: boolean;
  className?: string;
  /** Where the label and the ↗ give way: below `md` unless the toolbar says otherwise. */
  labelClassName?: string;
  arrowClassName?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title ?? label} aria-label={label} className={cn(toolButtonClass, className)}>
      <Icon className="size-4 shrink-0" />
      <span className={labelClassName}>{label}</span>
      {opensTab && <ArrowUpRight aria-hidden className={cn("-ml-1 size-3 shrink-0 text-text-subtle", arrowClassName)} />}
    </button>
  );
}

/** A phone's header: what the tab shows, and where — the connection's colour, name and schema. */
export function DbTabHeader({ title, subtitle, color, onClose, children }: {
  title: string;
  subtitle: string;
  color?: string | null;
  onClose?: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-1 border-b border-border-soft bg-panel-2 pl-3 pr-1 md:hidden">
      <div className="min-w-0 flex-1">
        <b className="block truncate text-[15px] text-text-primary">{title}</b>
        <small className="flex min-w-0 items-center gap-1.5 text-xs text-text-subtle">
          {color && <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
          <span className="truncate">{subtitle}</span>
        </small>
      </div>
      {children}
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Close this tab" className="grid size-11 shrink-0 place-items-center rounded-md text-text-2">
          <X className="size-5" />
        </button>
      )}
    </header>
  );
}

/** What a tab shows while it has nothing else to: reading, the reason it could not, or the driver it needs. */
export function DbTabState({ loading, error, driver, empty }: {
  loading?: boolean;
  error?: string | null;
  driver?: MissingDbDriver | null;
  /** Said when there is neither a result nor an error, e.g. a tab naming no connection. */
  empty?: string;
}) {
  if (driver) {
    return (
      <div className="flex h-full justify-center overflow-y-auto p-4">
        <DriverMissingNotice driver={driver} className="h-fit w-full max-w-md" />
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-subtle" role="status" aria-label="Loading">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  const text = error ?? empty;
  if (!text) return null;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-text-2">
      {error && <AlertCircle className="size-6 text-destructive" />}
      <p className="max-w-md break-words">{text}</p>
    </div>
  );
}
