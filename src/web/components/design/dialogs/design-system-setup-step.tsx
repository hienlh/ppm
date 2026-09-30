import { Loader2, Sparkles } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import type { DesignSystemSummary } from "../../../../shared/design-types";

/**
 * The New Design dialog's extra step when the chosen app's design system is not set up yet
 * (option B from the design-mode decisions: offered at the first design, never run on its
 * own). "Set up first" and "Skip" both still create the design; only whether the showcase
 * chat also starts running differs.
 */
export function DesignSystemSetupStep({ system, busy, onSetupFirst, onSkip }: {
  system: DesignSystemSummary;
  busy: boolean;
  onSetupFirst: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-md border border-border p-3">
        <Sparkles className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="space-y-1">
          <p className="text-sm font-medium">Set up "{system.label}"'s design system first?</p>
          <p className="text-xs leading-relaxed text-text-subtle">
            Learns this app's colours, type and components from its real code, so every design
            for it matches. Takes a minute in its own chat; you can do this later from a
            design's canvas menu instead.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Button className="min-h-11 md:min-h-9" disabled={busy} onClick={onSetupFirst}>
          {busy && <Loader2 className="size-4 animate-spin" />} Set up design system first (recommended)
        </Button>
        <Button variant="outline" className="min-h-11 md:min-h-9" disabled={busy} onClick={onSkip}>
          Skip for now
        </Button>
      </div>
    </div>
  );
}
