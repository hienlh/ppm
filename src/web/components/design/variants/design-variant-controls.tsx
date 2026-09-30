import { Check, ChevronDown, Layers, Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { DesignResponsiveDialog } from "../dialogs/design-responsive-dialog";
import type { DesignVariantsFeature } from "./use-design-variants";

/**
 * The variant switcher, on the desktop toolbar as a menu and in the phone's More sheet as
 * rows, plus the confirmation "Use this variant" asks for. Nothing renders for a design
 * with a single variant. Labels come from the agent's `design.json`; React renders them as
 * text only.
 */

const PICK_LABEL = "Use this variant";

export function DesignVariantMenu({ feature }: { feature: DesignVariantsFeature }) {
  if (!feature.multiple) return null;
  const current = feature.nameOf(feature.index);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`Variant: ${current}`} title="Variant"
          className="flex h-8 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-text-subtle hover:bg-surface-elevated hover:text-foreground">
          <Layers className="size-4 shrink-0" />
          <span className="truncate">{current}</span>
          <ChevronDown className="size-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-xs text-text-subtle">Variants</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={feature.file} onValueChange={feature.choose}>
          {feature.list.map((v, i) => (
            <DropdownMenuRadioItem key={v.file} value={v.file} className="pointer-coarse:min-h-11">
              {feature.nameOf(i)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!feature.canPick} onSelect={feature.openConfirm} className="pointer-coarse:min-h-11">
          <Check className="size-4" /> {PICK_LABEL}…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Phone: a section of the More sheet. Choosing closes the sheet so the canvas is in view. */
export function DesignVariantRows({ feature, onDone }: { feature: DesignVariantsFeature; onDone: () => void }) {
  if (!feature.multiple) return null;
  const row = "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-surface-elevated disabled:opacity-40";
  return (
    <>
      <p className="px-3 pt-1 text-xs font-semibold uppercase tracking-wide text-text-subtle">Variant</p>
      <div role="radiogroup" aria-label="Variant" className="flex flex-col gap-1">
        {feature.list.map((v, i) => {
          const on = i === feature.index;
          return (
            <button key={v.file} type="button" role="radio" aria-checked={on} className={cn(row, on && "text-foreground")}
              onClick={() => { feature.choose(v.file); onDone(); }}>
              <Layers className="size-5 text-text-subtle" />
              <span className="flex-1 truncate">{feature.nameOf(i)}</span>
              {on && <Check className="size-4 text-primary" />}
            </button>
          );
        })}
      </div>
      <button type="button" className={row} disabled={!feature.canPick} onClick={() => { onDone(); feature.openConfirm(); }}>
        <Check className="size-5 text-text-subtle" /> <span className="flex-1">{PICK_LABEL}</span>
      </button>
      <div className="my-1 h-px bg-border" />
    </>
  );
}

export function VariantPickDialog({ feature }: { feature: DesignVariantsFeature }) {
  const others = feature.list.length - 1;
  return (
    <DesignResponsiveDialog
      open={feature.confirmOpen}
      onClose={feature.closeConfirm}
      title={`${PICK_LABEL}?`}
      description={`${feature.nameOf(feature.index)} becomes the design, and the other ${others} variant${others === 1 ? " is" : "s are"} deleted. They are saved to Version history first, so you can restore them from there.`}
      footer={<>
        <Button variant="outline" onClick={feature.closeConfirm} disabled={feature.picking}>Cancel</Button>
        <Button onClick={feature.pick} disabled={!feature.canPick}>
          {feature.picking && <Loader2 className="size-4 animate-spin" />} {PICK_LABEL}
        </Button>
      </>}
    />
  );
}
