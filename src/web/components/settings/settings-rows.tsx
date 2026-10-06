/**
 * The rows the Notifications and PPMBot panes are built from, so the two Telegram
 * sections look and behave the same: a titled section, a switch whose whole label is
 * tappable, and an icon button with a 44px touch target.
 */
import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export function SectionHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

/** A labelled switch row, the whole label tappable. */
export function SwitchRow({ label, note, checked, disabled, onChange }: {
  label: ReactNode;
  note?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 px-4">
      {/* The padding is the label's, so a tap anywhere on the row's text reaches the switch. */}
      <label htmlFor={id} className={cn("min-w-0 flex-1 py-3", disabled ? "cursor-default" : "cursor-pointer")}>
        <span className="block text-sm">{label}</span>
        {note && <span className="block text-xs text-muted-foreground">{note}</span>}
      </label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

export function IconButton({ label, onClick, disabled, danger, children }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn("size-11 shrink-0 cursor-pointer md:size-9", danger && "text-error hover:text-error")}
    >
      {children}
    </Button>
  );
}
