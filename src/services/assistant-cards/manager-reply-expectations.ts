/**
 * The session tools tell PPM Assistant's card service that a manager chat now owes the Assistant
 * an answer nobody waits for (see `managerAsked` in `collab-assistant-hooks.ts`). A setter rather
 * than an import, so the session tools never load the card service and its listeners themselves.
 */

type Hook = (assistantSessionId: string, managerSessionId: string, projectName: string, queued: boolean) => void;

let hook: Hook | null = null;

/** The card service registers here when it starts; null unregisters it. */
export function setManagerAskedHook(fn: Hook | null): void {
  hook = fn;
}

export function noteManagerAsked(assistantSessionId: string, managerSessionId: string, projectName: string, queued: boolean): void {
  hook?.(assistantSessionId, managerSessionId, projectName, queued);
}
