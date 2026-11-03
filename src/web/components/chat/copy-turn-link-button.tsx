/**
 * Copy turn link, in a user message's action bar: the message is where a turn starts.
 *
 * The clipboard is only ever written inside the click. Browsers refuse a write that is not part
 * of a user gesture (always on plain HTTP, where PPM is often reached), and a write landing
 * minutes later would replace whatever the user copied in between. So a message whose turn id is
 * not known yet waits — a second click cancels — and once the id arrives the button says the link
 * is ready; the next click copies it.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Link, Loader2 } from "@/lib/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { buildTurnLink } from "@/lib/turn-link";
import { knownTurnId, resolveTurnId } from "@/lib/resolve-turn-id";
import { useBoundTurnId } from "@/stores/turn-binding-store";
import type { ChatMessage } from "../../../types/chat";
import { ActionButton } from "./message-action-bar";

type TurnMessage = Pick<ChatMessage, "turnId" | "clientId" | "sdkUuid">;
type CopyState =
  | { kind: "idle" }
  | { kind: "waiting"; abort: AbortController }
  | { kind: "ready"; turnId: string }
  | { kind: "copied" };

const FEEDBACK_MS = 1500;

export function CopyTurnLinkButton({ message, projectName, sessionId, providerId }: {
  message: TurnMessage;
  projectName: string;
  /** The tab's current session id: after a rename it is the id the transcript lives under. */
  sessionId: string;
  providerId: "claude" | "codex";
}) {
  const [state, setState] = useState<CopyState>({ kind: "idle" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const messageRef = useRef(message);
  messageRef.current = message;
  // Subscribed so a bound id re-renders this button even while nothing else about the bubble changes.
  useBoundTurnId(message.clientId);
  // Leaving the page while waiting: stop asking, and say nothing afterwards.
  useEffect(() => () => {
    const current = stateRef.current;
    if (current.kind === "waiting") current.abort.abort();
  }, []);
  useEffect(() => {
    if (state.kind !== "copied") return;
    const timer = setTimeout(() => setState({ kind: "idle" }), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = (turnId: string) => {
    const link = buildTurnLink(window.location.origin, { projectName, providerId, sessionId, turnId });
    // The clipboard call starts here, inside the click, while the gesture still counts.
    void copyToClipboard(link).then((ok) => {
      if (ok) {
        setState((s) => (s.kind === "idle" || s.kind === "ready" ? { kind: "copied" } : s));
        return;
      }
      toast.error("Could not copy the turn link");
      setState((s) => (s.kind === "ready" ? s : { kind: "idle" }));
    });
  };

  const onClick = () => {
    const current = stateRef.current;
    if (current.kind === "waiting") { current.abort.abort(); setState({ kind: "idle" }); return; }
    const known = current.kind === "ready" ? current.turnId : knownTurnId(messageRef.current);
    if (known) { copy(known); return; }
    const abort = new AbortController();
    setState({ kind: "waiting", abort });
    void resolveTurnId(() => messageRef.current, { projectName, sessionId, providerId }, { signal: abort.signal }).then((turnId) => {
      // Cancelled, or the bubble is gone: whatever came back is not wanted any more.
      if (abort.signal.aborted) return;
      setState(turnId ? { kind: "ready", turnId } : { kind: "idle" });
      if (!turnId) toast.error("Couldn't get this turn's id yet");
    });
  };

  const view = {
    idle: { icon: <Link className="size-3.5" />, label: "Copy turn link", title: "Copy a link to this turn, to paste into another chat" },
    waiting: { icon: <Loader2 className="size-3.5 animate-spin" />, label: "Getting link…", title: "Waiting for this turn to start. Click to stop waiting" },
    ready: { icon: <Link className="size-3.5 text-primary" />, label: "Link ready", title: "The turn link is ready. Click to copy it" },
    copied: { icon: <Check className="size-3.5" />, label: "Copied", title: "Turn link copied" },
  }[state.kind];

  return <ActionButton {...view} onClick={onClick} touchTarget iconOnlyBelowMd />;
}
