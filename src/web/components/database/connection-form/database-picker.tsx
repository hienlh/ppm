/**
 * Default database: a box to type the name in, and ▾ to pick it from what the server has.
 *
 * ▾ has to ask the server first — with the login typed above — so the tab runs that and opens
 * the list once the answer is in. A popover on a wider screen; a bottom sheet on a phone.
 */
import { forwardRef } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronDown, Database, Loader2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { usePortalContainer } from "@/components/ui/portal-container-context";
import { inputClass } from "./form-controls";

interface DatabasePickerProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  invalid?: boolean;
  /** The names to offer; null until the server has been asked. */
  databases: string[] | null;
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** ▾: ask the server when there is no list yet, then open it. */
  onRequestList: () => void;
  /** `N databases on localhost:5432`. */
  subtitle: string;
}

export const DatabasePicker = forwardRef<HTMLInputElement, DatabasePickerProps>(function DatabasePicker(
  { id, value, onChange, onKeyDown, invalid, databases, busy, open, onOpenChange, onRequestList, subtitle }, ref,
) {
  const isMobile = useIsMobile();
  const portalContainer = usePortalContainer();
  const pick = (name: string) => { onChange(name); onOpenChange(false); };

  const combo = (
    <div className="flex min-w-0">
      <input
        ref={ref}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="(not selected - optional)"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        className={cn(inputClass, "font-mono rounded-r-none")}
      />
      <button
        type="button"
        onClick={onRequestList}
        disabled={busy}
        aria-label="List the server's databases"
        title="List the server's databases"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="grid place-items-center shrink-0 size-11 md:h-[30px] md:w-8 rounded-r-md border border-l-0 border-border bg-surface text-text-2 can-hover:hover:text-text-primary disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className="size-4" />}
      </button>
    </div>
  );

  const list = databases && (
    <div role="listbox" aria-label="Default database" className="min-h-0 flex-1 overflow-y-auto py-1">
      <Row label="(not selected)" picked={!value.trim()} mobile={isMobile} onPick={() => pick("")} />
      {databases.map((name) => (
        <Row key={name} label={name} mono picked={value.trim() === name} mobile={isMobile} onPick={() => pick(name)} />
      ))}
    </div>
  );
  const heading = (
    <div className="flex items-center gap-2 border-b border-border-soft px-3 py-2 shrink-0">
      <Database className="size-4 shrink-0 text-text-subtle" />
      <div className="min-w-0">
        <div className="text-[13px] md:text-xs font-medium text-text-primary">Default database</div>
        <div className="truncate text-[12px] md:text-[11px] text-text-subtle">{subtitle}</div>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <>
        {combo}
        <BottomSheet open={open && !!databases} onClose={() => onOpenChange(false)} className="popover-solid flex max-h-[80dvh] flex-col">
          {heading}
          {list}
        </BottomSheet>
      </>
    );
  }

  return (
    <Popover.Root open={open && !!databases} onOpenChange={onOpenChange}>
      <Popover.Anchor asChild>{combo}</Popover.Anchor>
      <Popover.Portal container={portalContainer}>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="popover-solid z-50 flex w-[var(--radix-popover-trigger-width)] min-w-64 flex-col overflow-hidden rounded-md border border-border text-popover-foreground shadow-lg max-h-[min(20rem,var(--radix-popover-content-available-height))]"
        >
          {heading}
          {list}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

function Row({ label, mono, picked, mobile, onPick }: { label: string; mono?: boolean; picked: boolean; mobile: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={picked}
      onClick={onPick}
      className={cn(
        "flex w-full items-center gap-2 px-3 text-left text-sm text-text-2 can-hover:hover:bg-surface-hover can-hover:hover:text-text-primary",
        mobile ? "min-h-11 py-2" : "py-1",
        mono && "font-mono",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {picked && <Check className="size-3.5 shrink-0 text-primary" />}
    </button>
  );
}
