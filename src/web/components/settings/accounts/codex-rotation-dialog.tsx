/**
 * Which Codex account a new chat picks.
 *
 * Behind a Rotation button like the Claude side, rather than a row of chips wired straight
 * into the pane: the two providers answer the same question and should be reached the same
 * way. Presentational — the pane writes the choice.
 */

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CodexStrategy = "round-robin" | "fill-first" | "lowest-usage";

const STRATEGIES: { value: CodexStrategy; label: string; hint: string }[] = [
  { value: "round-robin", label: "Round-robin", hint: "Take the next account each time." },
  { value: "fill-first", label: "Fill-first", hint: "Stay on one account until it runs out." },
  { value: "lowest-usage", label: "Lowest usage", hint: "Pick whichever has the most left." },
];

export function CodexRotationDialog({ open, onOpenChange, strategy, onChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  strategy: CodexStrategy;
  onChange: (strategy: CodexStrategy) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Codex Rotation</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            How a new chat chooses among your Codex accounts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {STRATEGIES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => onChange(s.value)}
              aria-current={strategy === s.value ? "true" : undefined}
              className={cn(
                "w-full text-left rounded-md border px-3 py-2.5 min-h-11 cursor-pointer transition-colors",
                strategy === s.value
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-accent/50 active:bg-accent",
              )}
            >
              <p className="text-sm font-medium">{s.label}</p>
              <p className="text-xs text-muted-foreground">{s.hint}</p>
            </button>
          ))}
        </div>

        <DialogFooter>
          <Button size="sm" variant="outline" className="text-xs cursor-pointer" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
