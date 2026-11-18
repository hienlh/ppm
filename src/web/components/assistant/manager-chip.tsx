/**
 * One project's manager chat in the Assistant's chip row: a dot (working, waiting on you, idle),
 * the project's name and how many of its cards wait. Pressing the name opens that manager chat —
 * in a window of its own on a desktop, as a tab in its project on a phone; pressing the red count
 * opens the "Waiting on you" bar on that project's first card. The pill is 26 px tall, the chip
 * row's phone height, and is its own press area.
 */
import { cn } from "@/lib/utils";
import { MANAGER_DOT_CLASS, MANAGER_DOT_LABEL, managerDotState } from "@/lib/assistant-manager-chip-state";
import type { ManagerChatSummary } from "../../../shared/assistant-managers";
import { focusWaitingCards } from "@/stores/assistant-open-cards-store";
import { openManagerChat } from "./open-manager-chat";

/** The red count used on chips, the filter rows and the window's own head. */
export function WaitingBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-error px-[5px] text-[10.5px] font-semibold leading-none text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function ManagerDot({ manager, waiting }: { manager: Pick<ManagerChatSummary, "phase" | "waiting">; waiting: number }) {
  const state = managerDotState(manager, waiting);
  return <span aria-hidden className={cn("size-2 shrink-0 rounded-full", MANAGER_DOT_CLASS[state])} data-dot={state} />;
}

export function ManagerChip({ manager, waiting }: { manager: ManagerChatSummary; waiting: number }) {
  const state = managerDotState(manager, waiting);
  const label = `Open the ${manager.projectName} manager chat · ${MANAGER_DOT_LABEL[state]}${waiting ? ` · ${waiting} waiting` : ""}`;
  const showLabel = `Show the ${waiting} card${waiting === 1 ? "" : "s"} from ${manager.projectName} waiting on you`;
  // Two buttons in one drawn pill: the name opens the manager chat, the red count opens the
  // "Waiting on you" bar on that project's first card. Both are the pill's own 26px height.
  return (
    <span className="group relative flex h-[26px] shrink-0 items-center" data-manager-chip={manager.projectName}>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full border border-border bg-panel-2 transition-colors group-hover:border-accent-wash-border"
      />
      <button
        type="button"
        onClick={() => void openManagerChat({ projectName: manager.projectName, sessionId: manager.sessionId, title: manager.title })}
        aria-label={label}
        title={label}
        className={cn(
          "relative flex h-[26px] items-center gap-1.5 whitespace-nowrap pl-2.5 text-xs text-text-secondary transition-colors hover:text-text-primary",
          waiting > 0 ? "pr-1" : "pr-2.5",
        )}
      >
        <ManagerDot manager={manager} waiting={waiting} />
        {manager.projectName}
      </button>
      {waiting > 0 && (
        <button
          type="button"
          onClick={() => focusWaitingCards(manager.projectName)}
          aria-label={showLabel}
          title={showLabel}
          className="relative flex h-[26px] items-center pr-1.5"
          data-manager-chip-count=""
        >
          <WaitingBadge count={waiting} />
        </button>
      )}
    </span>
  );
}
