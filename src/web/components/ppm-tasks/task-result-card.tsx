/**
 * The task's result: what the work came to. A task handed to a chat is checked until it has one,
 * so recording it here also stops the checks. Empty: "No result yet" with a field to write it.
 */
import { useState } from "react";
import { CheckCircle2, Pencil } from "@/lib/icons";
import { PPM_TASK_LIMITS } from "../../../shared/ppm-tasks";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import { TaskResultBlock } from "./kit/task-result-block";
import { CardTextButton, PlainTextEditor, TaskCard } from "./task-card";

export function TaskResultCard({ task, onSave }: { task: TaskDto; onSave(result: { text: string } | null): void }) {
  const [editing, setEditing] = useState(false);
  const save = (v: string) => {
    setEditing(false);
    const text = v.trim();
    if (text === (task.result?.text ?? "")) return;
    onSave(text ? { text } : null);
  };
  if (task.result && !editing) {
    return (
      <div data-task-card="result">
        <TaskResultBlock result={task.result} action={<CardTextButton onClick={() => setEditing(true)}><Pencil className="size-3" />Edit</CardTextButton>} />
      </div>
    );
  }
  const handedOff = task.workingSession.kind === "session" && !!task.handedOffAt;
  return (
    <TaskCard title={<span className="inline-flex items-center gap-1.5"><CheckCircle2 aria-hidden className="size-3.5 text-text-3" />Result</span>} data-task-card="result">
      {editing ? (
        <PlainTextEditor value={task.result?.text ?? ""} label="Result" placeholder="What the work came to" maxLength={PPM_TASK_LIMITS.result}
          onSave={save} onCancel={() => setEditing(false)} />
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-3">
          <span>No result yet{handedOff ? " · the working chat is checked until one is recorded" : ""}</span>
          <CardTextButton onClick={() => setEditing(true)}>Record result</CardTextButton>
        </div>
      )}
    </TaskCard>
  );
}
