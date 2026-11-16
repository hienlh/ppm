/**
 * "Tasks are off for <project>": the switch is per project and off by default. Turning it on shows
 * the list; a project that has a manager chat already turned it on by itself, so this mostly
 * appears for projects without one.
 */
import { useState } from "react";
import { toast } from "sonner";
import { ListTodo } from "@/lib/icons";
import { Button } from "@/components/ui/button";

export interface TasksOffEmptyStateProps {
  project: string;
  hasManager: boolean;
  onTurnOn(): Promise<unknown>;
}

export function TasksOffEmptyState({ project, hasManager, onTurnOn }: TasksOffEmptyStateProps) {
  const [busy, setBusy] = useState(false);
  const turnOn = async () => {
    setBusy(true);
    try { await onTurnOn(); } catch (e) { toast.error(`Could not turn tasks on: ${(e as Error).message}`); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center" data-tasks-off={project}>
      <ListTodo aria-hidden className="size-6 text-text-3" />
      <p className="text-sm font-medium text-text">Tasks are off for {project}</p>
      <p className="text-xs text-text-3">
        {hasManager
          ? "This project has a manager chat, which normally turns tasks on by itself."
          : "Tasks turn on by themselves when the project gets a manager chat. Turning them off later hides them; nothing is deleted."}
      </p>
      <Button size="sm" className="mt-1" disabled={busy} onClick={() => void turnOn()}>Turn on tasks</Button>
    </div>
  );
}
