/**
 * Drag to reorder in the Tasks list, hand-rolled on pointer events (no drag library in PPM), mouse
 * and pen only: a phone gets "Reorder…" in its long-press sheet instead. A drag starts past 4px of
 * movement, so a click is still a click. While dragging, the group under the pointer and the index
 * among its top-level rows are tracked from the DOM (`data-task-group`, `data-task-row`); the drop
 * is planned by the pure `planDrop`: a reorder inside the task's cell, or a new urgency when it
 * lands in another group.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { URGENCIES, type Urgency } from "../../../shared/ppm-tasks";
import type { TaskDto } from "../../../shared/ppm-tasks-api";

export interface DropTarget {
  urgency: Urgency;
  /** Index among the group's top-level rows, the dragged one left out. */
  index: number;
}

const THRESHOLD = 4;

/** Where `y` falls in a list: the group under it, and how many of its rows sit above it. */
export function dropTargetAt(container: HTMLElement, y: number, draggedId: string): DropTarget | null {
  const groups = [...container.querySelectorAll<HTMLElement>("[data-task-group]")];
  if (groups.length === 0) return null;
  let group = groups.find((g) => { const r = g.getBoundingClientRect(); return y >= r.top && y < r.bottom; });
  if (!group) group = y < groups[0]!.getBoundingClientRect().top ? groups[0]! : groups[groups.length - 1]!;
  const urgency = group.dataset.taskGroup as Urgency;
  if (!URGENCIES.includes(urgency)) return null;
  const rows = [...group.querySelectorAll<HTMLElement>('[data-task-row][data-depth="0"]')].filter((r) => r.dataset.taskRow !== draggedId);
  const index = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 < y; }).length;
  return { urgency, index };
}

export function useTaskRowDrag(containerRef: RefObject<HTMLElement | null>, onDrop: (task: TaskDto, target: DropTarget) => void) {
  const [dragging, setDragging] = useState<TaskDto | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const start = useRef<{ x: number; y: number; task: TaskDto; active: boolean } | null>(null);
  const targetRef = useRef<DropTarget | null>(null);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  // The click that follows a drop lands on a row; it must not also select that row.
  const justDropped = useRef(false);

  const finish = useCallback((commit: boolean) => {
    const s = start.current;
    start.current = null;
    if (s?.active) {
      justDropped.current = true;
      setTimeout(() => { justDropped.current = false; }, 0);
      if (commit && targetRef.current) dropRef.current(s.task, targetRef.current);
    }
    targetRef.current = null;
    setDragging(null);
    setTarget(null);
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    const move = (e: globalThis.PointerEvent) => {
      const s = start.current;
      if (!s) return;
      // The button came up somewhere this window never heard about (an iframe): end, not drop.
      if (e.buttons === 0) { finish(false); return; }
      if (!s.active) {
        if (Math.abs(e.clientX - s.x) < THRESHOLD && Math.abs(e.clientY - s.y) < THRESHOLD) return;
        s.active = true;
        setDragging(s.task);
        document.body.style.userSelect = "none";
      }
      const el = containerRef.current;
      const next = el ? dropTargetAt(el, e.clientY, s.task.id) : null;
      targetRef.current = next;
      setTarget((prev) => (prev?.urgency === next?.urgency && prev?.index === next?.index ? prev : next));
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && start.current?.active) finish(false); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [containerRef, finish]);

  /** Arms a drag on a row; buttons inside the row (the chat chip) keep their own clicks. */
  const onPointerDown = useCallback((e: PointerEvent<HTMLElement>, task: TaskDto) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea")) return;
    start.current = { x: e.clientX, y: e.clientY, task, active: false };
  }, []);

  /** True for the click that ends a drag: the caller ignores it. */
  const swallowClick = useCallback(() => justDropped.current, []);

  return { dragging, target, onPointerDown, swallowClick };
}
