import { useCallback, useEffect, useRef, useState } from "react";
import { buildAutoCheckMessage } from "../../../shared/design-canvas-check-format";
import {
  autoSent, INITIAL_AUTO_CHECK_ROUNDS, mayAutoSend, turnStarted,
} from "@/lib/design/design-auto-check-rounds";
import { autoSendToDesignChat } from "@/lib/design/deliver-to-design-chat";
import type { DesignTabContextValue } from "./design-tab-context";
import type { DesignBridge } from "./canvas/use-design-bridge";
import type { CanvasIssue } from "./canvas/design-issues-badge";
import { runCanvasCheck, type CanvasCheckContext } from "./canvas/use-design-canvas-check";

/**
 * The check PPM runs by itself after a design turn: the agent never sees the canvas, so a
 * turn that "finished" can leave a broken layout nobody reported.
 *
 * A turn changed the design when the canvas reloaded during it or reloads within
 * {@link CHANGE_WAIT_MS} of its end (the live reload trails the last write by 300 ms). Once
 * the reloads settle, the canvas is measured without a screenshot; what it finds goes into
 * the canvas issues badge, and — while the rounds allow it — back to the agent as a
 * `[Canvas check]` message (see `design-auto-check-rounds.ts`).
 */

const CHANGE_WAIT_MS = 8_000;
/** Quiet time after the last reload before measuring: a burst of writes reloads repeatedly. */
const SETTLE_MS = 700;

export function useDesignAutoCheck(opts: {
  tab: DesignTabContextValue;
  bridge: DesignBridge;
  context: () => CanvasCheckContext;
}): CanvasIssue[] {
  const { tab, bridge } = opts;
  const [layoutIssues, setLayoutIssues] = useState<CanvasIssue[]>([]);
  const ref = useRef(opts);
  ref.current = opts;
  const rounds = useRef(INITIAL_AUTO_CHECK_ROUNDS);
  const readies = useRef(0);
  const readiesAtTurnStart = useRef(0);
  const pending = useRef<{ settle: ReturnType<typeof setTimeout> | null; giveUp: ReturnType<typeof setTimeout> | null } | null>(null);

  const cancelPending = useCallback(() => {
    if (!pending.current) return;
    if (pending.current.settle) clearTimeout(pending.current.settle);
    if (pending.current.giveUp) clearTimeout(pending.current.giveUp);
    pending.current = null;
  }, []);

  const check = useCallback(async () => {
    const { tab: t, bridge: b, context } = ref.current;
    try {
      const report = await runCanvasCheck(b, context(), { screenshot: false });
      setLayoutIssues(report.findings.filter((f) => f.kind !== "runtime").map((f) => ({ kind: "layout", message: f.message, source: f.element })));
      const message = buildAutoCheckMessage(report, t.slug);
      if (!message || !mayAutoSend(rounds.current)) return;
      if (autoSendToDesignChat(t.tabId, message, "Canvas check") === "sent") rounds.current = autoSent(rounds.current);
    } catch (e) {
      console.warn(`[design] automatic canvas check skipped: ${(e as Error).message}`);
    }
  }, []);

  /** Measure once the canvas has been quiet for SETTLE_MS; restarted by every reload. */
  const armSettle = useCallback(() => {
    if (!pending.current) return;
    if (pending.current.settle) clearTimeout(pending.current.settle);
    pending.current.settle = setTimeout(() => { cancelPending(); void check(); }, SETTLE_MS);
  }, [cancelPending, check]);

  useEffect(() => bridge.on("ready", () => {
    readies.current++;
    // A new document: whatever the last check found was about the previous one.
    setLayoutIssues([]);
    armSettle();
  }), [bridge.on, armSettle]); // eslint-disable-line react-hooks/exhaustive-deps

  const wasStreaming = useRef(tab.isStreaming);
  useEffect(() => {
    const was = wasStreaming.current;
    wasStreaming.current = tab.isStreaming;
    if (tab.isStreaming && !was) {
      cancelPending();
      rounds.current = turnStarted(rounds.current);
      readiesAtTurnStart.current = readies.current;
      return;
    }
    if (!was || tab.isStreaming || !tab.sessionId) return;
    // The turn ended. Wait for the design to reload; no reload at all means it did not change.
    // A reload already seen and settling is left to finish.
    pending.current = { settle: null, giveUp: setTimeout(() => { if (!pending.current?.settle) cancelPending(); }, CHANGE_WAIT_MS) };
    if (readies.current > readiesAtTurnStart.current) armSettle();
  }, [tab.isStreaming, tab.sessionId, armSettle, cancelPending]);

  useEffect(() => cancelPending, [cancelPending]);
  return layoutIssues;
}
