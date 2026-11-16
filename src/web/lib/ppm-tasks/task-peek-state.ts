/**
 * Which task the chat's Tasks list shows in its quick view, and what Escape closes.
 *
 * On a desktop the quick view is a popover beside the list; below `md` it is a page of the list's
 * own sheet. Either way the list stays open while a task is shown: a click on a row shows that
 * task, a click on the row already shown hides it again (desktop), Escape hides the task first and
 * only a second Escape closes the list, and a press outside both closes both (the list's own
 * outside press, which unmounts the quick view with it).
 */

export interface TaskPeekState {
  /** The task shown, or null when only the list is. */
  taskId: string | null;
}

export type TaskPeekEvent =
  /** A row was clicked. `toggle`: a click on the task already shown hides it (the desktop popover). */
  | { type: "row"; taskId: string; toggle: boolean }
  /** ‹ in the phone's sheet, or a close button. */
  | { type: "back" }
  | { type: "escape" };

export interface TaskPeekStep {
  state: TaskPeekState;
  /** The list closes too (the second Escape). */
  closeList: boolean;
}

export const NO_PEEK: TaskPeekState = { taskId: null };

export function taskPeekStep(state: TaskPeekState, event: TaskPeekEvent): TaskPeekStep {
  switch (event.type) {
    case "row":
      return { state: { taskId: event.toggle && state.taskId === event.taskId ? null : event.taskId }, closeList: false };
    case "back":
      return { state: NO_PEEK, closeList: false };
    case "escape":
      return state.taskId ? { state: NO_PEEK, closeList: false } : { state, closeList: true };
  }
}
