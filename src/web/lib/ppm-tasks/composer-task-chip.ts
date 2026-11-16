/**
 * The task chip a chat's composer shows after "Open chat" on a task: "Task #12 · Fix login".
 *
 * A manager chat works on many tasks, so a message typed there after opening it from a task says
 * nothing about which one is meant. The chip makes the next message carry the task: it is sent as
 * the task's id alone (`taskRefs` on the message), and the server writes the block the AI reads
 * from the task store (`src/services/ppm-tasks/task-chat-ref.ts`).
 *
 * The chip lives in the chat tab's metadata (`pendingTaskRefs`), the way other hand-overs to a chat
 * tab do (`pendingContexts`): it reaches a tab that is not mounted yet, and a mounted one re-renders
 * with it. Sending removes it, so it does not come back after a reload; until then it stays with
 * the tab like an unsent draft would.
 */
import { usePanelStore } from "@/stores/panel-store";
import { currentTabMetadata, patchTabMetadata } from "@/lib/patch-tab-metadata";
import { pickChatTabForSession, readTaskChips, TASK_CHIP_META_KEY, withTaskChip, type ComposerTaskChip } from "./composer-task-chip-logic";

export * from "./composer-task-chip-logic";

function chatTabFor(sessionId: string): string | null {
  const { panels, focusedPanelId } = usePanelStore.getState();
  const tabs = Object.values(panels).flatMap((p) => p.tabs.map((tab) => ({ tab, selected: p.activeTabId === tab.id, focused: p.id === focusedPanelId })));
  return pickChatTabForSession(tabs, sessionId);
}

const FIND_TAB_MS = 4000;
const FIND_TAB_STEP_MS = 50;

/**
 * Puts `chip` in the composer of the chat tab showing `sessionId`, once that tab exists. Called
 * right after the chat was opened: a project switch can place the tab a moment later. Returns
 * whether a tab took it.
 */
export async function attachTaskChip(sessionId: string, chip: ComposerTaskChip): Promise<boolean> {
  const deadline = Date.now() + FIND_TAB_MS;
  for (;;) {
    const tabId = chatTabFor(sessionId);
    if (tabId) {
      patchTabMetadata(tabId, { [TASK_CHIP_META_KEY]: withTaskChip(readTaskChips(currentTabMetadata(tabId)), chip) });
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, FIND_TAB_STEP_MS));
  }
}

/** Writes a tab's chips; an empty list removes the key, so nothing is restored after a reload. */
export function setTaskChips(tabId: string, chips: readonly ComposerTaskChip[]): void {
  patchTabMetadata(tabId, { [TASK_CHIP_META_KEY]: chips.length ? [...chips] : undefined });
}
