/**
 * The quick view a task chip opens — in the composer, or on a sent message. On a desktop it is the
 * popover anchored to the chip (above it, else below, else beside), closed by Escape, × or a press
 * outside it and the chip; Open in window opens the task's window. Below `md` it is a bottom sheet
 * with the same page, and Full screen opens the task as a tab.
 */
import type { RefObject } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { openTask, openTaskFullScreen } from "@/lib/ppm-tasks/open-task";
import type { TaskTabTarget } from "@/lib/ppm-tasks/open-task-tab";
import type { PeekSide } from "@/lib/ppm-tasks/task-peek-placement";
import { TaskPeekPopover, taskPeekLabel } from "./task-peek-popover";
import { TaskPeekBody } from "./task-peek-body";

/** A chip sits in a line of text: above it, else below, else beside. */
const CHIP_PEEK_SIDES: readonly PeekSide[] = ["top", "bottom", "right", "left"];

export function TaskChipPeek({ target, anchorRef, onClose }: { target: TaskTabTarget; anchorRef: RefObject<HTMLElement | null>; onClose(): void }) {
  const mobile = useIsMobile();
  if (mobile) {
    return (
      <BottomSheet open onClose={onClose} className="flex max-h-[85%] flex-col">
        <div role="dialog" aria-label={taskPeekLabel(target)} className="flex min-h-0 flex-1 flex-col text-sm">
          <TaskPeekBody target={target} layout="sheet" onLeave={onClose} onOpenPage={(t) => { onClose(); openTaskFullScreen(t); }} />
        </div>
      </BottomSheet>
    );
  }
  return (
    <TaskPeekPopover target={target} avoidRef={anchorRef} sides={CHIP_PEEK_SIDES} dismissOnOutside
      onClose={onClose} onLeave={onClose} onOpenWindow={(t) => { onClose(); openTask(t); }} />
  );
}
