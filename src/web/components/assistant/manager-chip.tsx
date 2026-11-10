/**
 * One project's manager chat in the Assistant's chip row: a dot (working, waiting on you, idle),
 * the project's name and how many of its cards wait. Pressing it opens that manager chat — in a
 * window of its own on a desktop, as a tab in its project on a phone. The pill is drawn 26–32 px
 * tall inside a 44 px hit area below `md`.
 */
import { cn } from "@/lib/utils";
import { MANAGER_DOT_CLASS, MANAGER_DOT_LABEL, managerDotState } from "@/lib/assistant-manager-chip-state";
import type { ManagerChatSummary } from "../../../shared/assistant-managers";
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
  return (
    <button
      type="button"
      onClick={() => void openManagerChat({ projectName: manager.projectName, sessionId: manager.sessionId, title: manager.title })}
      aria-label={label}
      title={label}
      data-manager-chip={manager.projectName}
      className="group flex h-11 shrink-0 items-center md:h-auto"
    >
      <span className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-panel-2 px-2.5 text-xs text-text-secondary transition-colors group-hover:border-accent-wash-border group-hover:text-text-primary md:h-[26px]">
        <ManagerDot manager={manager} waiting={waiting} />
        {manager.projectName}
        <WaitingBadge count={waiting} />
      </span>
    </button>
  );
}
