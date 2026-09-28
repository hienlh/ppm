import { useCallback, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { undoDesignEdit } from "@/lib/design/api-design-edits";

/**
 * The canvas's Undo: a per-tab stack of the server's undo ids, newest last.
 *
 * Every canvas write (a move or resize, a tweak Apply) pushes the id the server returned.
 * Undo sends the newest one; the server reverts exactly that write, and only if the text it
 * left is still there. When it is not (an AI turn rewrote that spot, the server restarted
 * and lost its journal), that one entry is dropped and the ones below it stay usable: they
 * are independent edits, each checked on its own. In memory only, like the server journal.
 */

export const MAX_UNDO_DEPTH = 50;

const stacks = new Map<string, string[]>();
const listeners = new Set<() => void>();
const emit = () => { for (const fn of listeners) fn(); };

export function pushDesignUndo(tabId: string, undoId: string): void {
  const stack = [...(stacks.get(tabId) ?? []), undoId].slice(-MAX_UNDO_DEPTH);
  stacks.set(tabId, stack);
  emit();
}

export function peekDesignUndo(tabId: string): string | null {
  const stack = stacks.get(tabId);
  return stack && stack.length ? stack[stack.length - 1]! : null;
}

/** Removes that id wherever it is, leaving every other entry in place. */
export function dropDesignUndo(tabId: string, undoId: string): void {
  const stack = stacks.get(tabId);
  if (!stack || !stack.includes(undoId)) return;
  stacks.set(tabId, stack.filter((id) => id !== undoId));
  emit();
}

export function designUndoDepth(tabId: string): number {
  return stacks.get(tabId)?.length ?? 0;
}

export function subscribeDesignUndo(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useDesignUndo(
  tab: { projectName: string; slug: string; tabId: string; isStreaming: boolean },
  opts: { openHistory: () => void },
) {
  const { projectName, slug, tabId, isStreaming } = tab;
  const depth = useSyncExternalStore(subscribeDesignUndo, () => designUndoDepth(tabId));
  const [busy, setBusy] = useState(false);
  const { openHistory } = opts;

  const undo = useCallback(async () => {
    const id = peekDesignUndo(tabId);
    if (!id || busy) return;
    setBusy(true);
    try {
      const out = await undoDesignEdit(projectName, slug, id);
      dropDesignUndo(tabId, id);
      if (out.status === "undone") {
        toast.success("Canvas edit undone");
      } else {
        toast.warning(out.status === "unknown" ? "That edit can no longer be undone" : "Cannot undo: the file changed since", {
          description: "Version history still has the design as it was before that edit.",
          action: { label: "History", onClick: openHistory },
        });
      }
    } catch (e) {
      // A network failure says nothing about the edit, so it stays on the stack.
      toast.error("Could not undo", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [projectName, slug, tabId, busy, openHistory]);

  return {
    depth,
    busy,
    // An agent may be writing the same file; its turn ends before an undo is worth trying.
    canUndo: depth > 0 && !busy && !isStreaming,
    undo: () => { void undo(); },
  };
}

export type DesignUndoFeature = ReturnType<typeof useDesignUndo>;
