/**
 * "Filter" at the head of the chip row: which project's cards and turns the stream shows. A
 * dropdown on a desktop, a bottom sheet on a phone; the choice is this device's own.
 */
import { useState } from "react";
import { ChevronDown, Filter } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ManagerChatSummary } from "../../../shared/assistant-managers";
import { AssistantFilterSheet, FILTER_EXPLAINER, FILTER_TITLE } from "./assistant-filter-sheet";
import { ManagerDot, WaitingBadge } from "./manager-chip";

const ALL = "__all__";

interface Props {
  filter: string | null;
  managers: readonly ManagerChatSummary[];
  waiting: Record<string, number>;
  onPick: (project: string | null) => void;
}

function Pill({ filter, ...rest }: { filter: string | null } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" aria-label={`Filter: ${filter ?? "All"}`} data-assistant-filter="" className="flex h-11 shrink-0 items-center md:h-auto" {...rest}>
      <span className={cn(
        "flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs md:h-[26px]",
        "border-accent-wash-border bg-accent-wash text-primary",
      )}>
        <Filter className="size-3" />
        <span className="max-w-32 truncate">{filter ?? "All"}</span>
        <ChevronDown className="size-3" />
      </span>
    </button>
  );
}

export function AssistantFilterButton({ filter, managers, waiting, onPick }: Props) {
  const isMobile = useIsMobile();
  const [sheet, setSheet] = useState(false);
  if (isMobile) {
    return (
      <>
        <Pill filter={filter} onClick={() => setSheet(true)} />
        <AssistantFilterSheet open={sheet} onClose={() => setSheet(false)} filter={filter} managers={managers} waiting={waiting} onPick={onPick} />
      </>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Pill filter={filter} title="Filter by project" /></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{FILTER_TITLE}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={filter ?? ALL} onValueChange={(v) => onPick(v === ALL ? null : v)}>
          <DropdownMenuRadioItem value={ALL}>All</DropdownMenuRadioItem>
          {managers.map((m) => (
            <DropdownMenuRadioItem key={m.projectName} value={m.projectName} className="gap-2">
              <ManagerDot manager={m} waiting={waiting[m.projectName] ?? 0} />
              <span className="min-w-0 truncate">{m.projectName}</span>
              <span className="ml-auto"><WaitingBadge count={waiting[m.projectName] ?? 0} /></span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <p className="px-2 pb-1.5 pt-1 text-[11px] leading-relaxed text-text-subtle">{FILTER_EXPLAINER}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
