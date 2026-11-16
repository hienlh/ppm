/**
 * The task shown in the phone's bottom sheet, if any. Below `md` there are no windows, so a task
 * opened from the list, a chip or the palette shows in a sheet over the screen instead of taking
 * the screen over; `TaskSheetHost` renders it.
 */
import { create } from "zustand";

export interface TaskSheetTarget {
  id: string;
  project: string;
  title: string;
  number?: number;
}

interface TaskSheetState {
  task: TaskSheetTarget | null;
  show: (task: TaskSheetTarget) => void;
  close: () => void;
}

export const useTaskSheetStore = create<TaskSheetState>((set) => ({
  task: null,
  show: (task) => set({ task: { id: task.id, project: task.project, title: task.title, number: task.number } }),
  close: () => set({ task: null }),
}));
