/**
 * The strip under the Assistant's head: "Filter", a divider, then one chip per project's manager
 * chat with its waiting count. It scrolls sideways when the projects do not fit.
 */
import { useManagerChats } from "@/hooks/use-manager-chats";
import { useAssistantWaitingByProject } from "@/stores/assistant-waiting-store";
import { setAssistantCardFilter, useAssistantCardsStore } from "@/stores/assistant-cards-store";
import { AssistantFilterButton } from "./assistant-filter-button";
import { ManagerChip } from "./manager-chip";

export function ManagerChipRow() {
  const managers = useManagerChats() ?? [];
  const waiting = useAssistantWaitingByProject();
  const filter = useAssistantCardsStore((s) => s.filter);
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-3 [scrollbar-width:none] md:py-2"
      role="toolbar"
      aria-label="Manager chats"
      data-manager-chip-row=""
    >
      <AssistantFilterButton filter={filter} managers={managers} waiting={waiting} onPick={setAssistantCardFilter} />
      {managers.length > 0 && <span aria-hidden className="mx-0.5 w-px self-stretch bg-border md:my-0.5" />}
      {managers.map((m) => <ManagerChip key={m.projectName} manager={m} waiting={waiting[m.projectName] ?? 0} />)}
      {managers.length === 0 && (
        <span className="whitespace-nowrap text-xs text-text-subtle">No manager chats yet — set one from a chat's menu.</span>
      )}
    </div>
  );
}
