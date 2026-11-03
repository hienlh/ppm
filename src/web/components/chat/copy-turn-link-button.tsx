/**
 * Copy turn link, in a user message's action bar: the message is where a turn starts. Copies at
 * once when the turn's id is known; a message just sent whose turn has not started yet shows a
 * spinner and copies the moment `turn_started` (or the history reload) names it.
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

export function CopyTurnLinkButton({ message, projectName, sessionId, providerId }: {
  message: TurnMessage;
  projectName: string;
  /** The tab's current session id: after a rename it is the id the transcript lives under. */
  sessionId: string;
  providerId: "claude" | "codex";
}) {
  const [state, setState] = useState<"idle" | "waiting" | "copied">("idle");
  const mounted = useRef(true);
  const messageRef = useRef(message);
  messageRef.current = message;
  // Subscribed so a bound id re-renders this button even while nothing else about the bubble changes.
  useBoundTurnId(message.clientId);
  useEffect(() => () => { mounted.current = false; }, []);

  const copy = async (turnId: string) => {
    const link = buildTurnLink(window.location.origin, { projectName, providerId, sessionId, turnId });
    if (!(await copyToClipboard(link))) {
      toast.error("Could not copy the turn link");
      if (mounted.current) setState("idle");
      return;
    }
    if (!mounted.current) { toast.success("Turn link copied"); return; }
    setState("copied");
    setTimeout(() => { if (mounted.current) setState("idle"); }, 1500);
  };

  const onClick = () => {
    if (state === "waiting") return;
    const known = knownTurnId(messageRef.current);
    // Copied inside the click while the id is known, so the clipboard still sees the gesture.
    if (known) { void copy(known); return; }
    setState("waiting");
    void resolveTurnId(() => messageRef.current, { projectName, sessionId, providerId }).then((turnId) => {
      if (turnId) return copy(turnId);
      toast.error("Couldn't get this turn's id yet");
      if (mounted.current) setState("idle");
    });
  };

  return (
    <ActionButton
      icon={state === "waiting" ? <Loader2 className="size-3.5 animate-spin" /> : state === "copied" ? <Check className="size-3.5" /> : <Link className="size-3.5" />}
      label={state === "copied" ? "Copied" : "Copy turn link"}
      title="Copy a link to this turn, to paste into another chat"
      onClick={onClick}
      touchTarget
    />
  );
}
