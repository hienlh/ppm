/**
 * "Open as tab" in the titlebar of a task window: the task moves into the grid as a kept tab and
 * the window closes. A chip with text, sized to the chat footer's row (28px), whatever the skin.
 */
import { Columns2 } from "@/lib/icons";
import type { Tab } from "@/stores/tab-store";
import { moveTaskWindowToTab } from "@/lib/ppm-tasks/open-task";

export const OPEN_AS_TAB_LABEL = "Open as tab";

export function TaskWindowTitleExtras({ tab }: { tab: Tab }) {
  if (tab.type !== "task") return null;
  return (
    <button
      type="button"
      data-task-open-as-tab=""
      aria-label={OPEN_AS_TAB_LABEL}
      title={OPEN_AS_TAB_LABEL}
      onClick={() => moveTaskWindowToTab(tab)}
      className="mx-1 inline-flex h-7 shrink-0 items-center gap-1.5 self-center whitespace-nowrap rounded-full border border-border-soft bg-panel-2 px-2.5 text-[11.5px] text-text-2 transition-colors can-hover:hover:border-border can-hover:hover:text-text [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      <Columns2 aria-hidden />
      <span className="@max-[420px]/window:hidden">{OPEN_AS_TAB_LABEL}</span>
    </button>
  );
}
