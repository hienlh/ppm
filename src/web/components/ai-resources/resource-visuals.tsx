import { Hexagon, Bot, SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AiResourceType, AiResourceScope } from "@/lib/api-ai-resources";

export const TYPE_ICON: Record<AiResourceType, React.ElementType> = {
  skill: Hexagon,
  agent: Bot,
  command: SquareTerminal,
};

export const TYPE_LABEL: Record<AiResourceType, string> = {
  skill: "Skills",
  agent: "Agents",
  command: "Commands",
};

const SCOPE_STYLE: Record<AiResourceScope, string> = {
  project: "text-primary border-primary/30 bg-primary/10",
  user: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  bundled: "text-text-subtle border-border bg-surface-elevated",
};

const SCOPE_LABEL: Record<AiResourceScope, string> = {
  project: "Project",
  user: "User",
  bundled: "Bundled",
};

export function ScopeBadge({ scope, className }: { scope: AiResourceScope; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1 py-px text-[9px] font-medium uppercase leading-none tracking-wide",
        SCOPE_STYLE[scope],
        className,
      )}
    >
      {SCOPE_LABEL[scope]}
    </span>
  );
}
