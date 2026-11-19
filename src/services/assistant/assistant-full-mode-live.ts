/**
 * The running server's Full-mode instance (`assistant-full-mode.ts`), wired to the settings, the
 * turn provenance tracker and the session trace. Kept apart from the pure module so its decision
 * table is testable without a database.
 */
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { getSessionProvider } from "../db.service.ts";
import { traceServerEvent } from "../session-trace/trace-recorder.ts";
import { assistantDbWriteConnections, assistantPolicySwitches } from "./assistant-settings.service.ts";
import { assistantTurnStartedByUser } from "./assistant-shell-decision.ts";
import { createFullMode } from "./assistant-full-mode.ts";

export const assistantFullMode = createFullMode({
  fullMode: () => assistantPolicySwitches().fullMode,
  userStartedTurn: (sessionId) => assistantTurnStartedByUser([sessionId]),
  dbWriteConnections: assistantDbWriteConnections,
  record: (sessionId, entry) => traceServerEvent(sessionId, getSessionProvider(sessionId) ?? "claude", "assistant_auto_approved", entry),
  now: () => Date.now(),
});

chatLifecycle.on("turn_ended", (e) => assistantFullMode.turnEnded(e.sessionId));
