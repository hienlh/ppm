/**
 * Tells every PPM screen the notebook changed (`assistant:notes_changed` on `/ws/global`), so an
 * open Settings pane refetches. The event carries nothing: the list comes from the route. Loaded
 * on use, like the cards' announcer: the global socket loads after the services that write notes.
 */
import { broadcastGlobalEvent } from "../../server/ws/global.ts";
import { NOTES_CHANGED_EVENT } from "../../shared/assistant-notes.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-notes");

export function announceNotesChanged(): void {
  try {
    broadcastGlobalEvent({ type: NOTES_CHANGED_EVENT });
  } catch (e) {
    log.warn(`could not announce a notebook change: ${(e as Error).message}`);
  }
}
