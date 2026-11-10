/**
 * The project filter as a phone shows it: a bottom sheet of 48 px rows (All, then every project
 * with a manager chat, its dot and waiting count) and the line saying what a filter keeps.
 */
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { cn } from "@/lib/utils";
import type { ManagerChatSummary } from "../../../shared/assistant-managers";
import { ManagerDot, WaitingBadge } from "./manager-chip";

export const FILTER_EXPLAINER =
  "When filtered, the stream keeps only that project's cards and the Assistant's turns that asked or messaged its manager chat.";
export const FILTER_TITLE = "Filter by project";

function Row({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn("flex min-h-12 w-full items-center gap-3 rounded-[10px] px-2.5 text-left text-sm", on ? "bg-accent-wash font-medium text-primary" : "text-text-primary")}
    >
      {children}
      <span aria-hidden className={cn("ml-auto size-[18px] shrink-0 rounded-full border-2", on ? "border-primary bg-primary shadow-[inset_0_0_0_3px_var(--color-popover)]" : "border-border")} />
    </button>
  );
}

export function AssistantFilterSheet({ open, onClose, filter, managers, waiting, onPick }: {
  open: boolean;
  onClose: () => void;
  filter: string | null;
  managers: readonly ManagerChatSummary[];
  waiting: Record<string, number>;
  onPick: (project: string | null) => void;
}) {
  const pick = (project: string | null) => { onPick(project); onClose(); };
  return (
    <BottomSheet open={open} onClose={onClose} className="px-3 pb-4">
      <div role="radiogroup" aria-label={FILTER_TITLE} data-assistant-filter-sheet="">
        <h3 className="mx-1 mb-2.5 text-sm font-semibold">{FILTER_TITLE}</h3>
        <Row on={filter === null} onClick={() => pick(null)}>All</Row>
        {managers.map((m) => (
          <Row key={m.projectName} on={filter === m.projectName} onClick={() => pick(m.projectName)}>
            <ManagerDot manager={m} waiting={waiting[m.projectName] ?? 0} />
            <span className="min-w-0 truncate">{m.projectName}</span>
            <WaitingBadge count={waiting[m.projectName] ?? 0} />
          </Row>
        ))}
        <p className="px-2.5 pt-2 text-xs leading-relaxed text-text-secondary">{FILTER_EXPLAINER}</p>
      </div>
    </BottomSheet>
  );
}
