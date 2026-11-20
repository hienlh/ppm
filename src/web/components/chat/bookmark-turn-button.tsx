/**
 * Bookmark this turn, in a user message's action bar. A turn whose id is not known yet (a message
 * just sent) has nothing to bookmark, so the button waits for the id the same way Copy turn link
 * does; the list lives in the chat's ··· menu → Bookmarks.
 */
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Bookmark, Loader2 } from "@/lib/icons";
import { knownTurnId, resolveTurnId } from "@/lib/resolve-turn-id";
import { useBoundTurnId } from "@/stores/turn-binding-store";
import { useChatBookmarks, useSessionBookmarks } from "@/stores/session-bookmarks-store";
import { bookmarkLabelOf } from "../../../shared/session-bookmarks";
import type { ChatMessage } from "../../../types/chat";
import { ActionButton } from "./message-action-bar";

export function BookmarkTurnButton({ message, text, projectName, sessionId, providerId }: {
  message: Pick<ChatMessage, "turnId" | "turnN" | "clientId" | "sdkUuid">;
  /** The prompt as typed: the bookmark's label. */
  text: string;
  projectName: string;
  sessionId: string;
  providerId: "claude" | "codex";
}) {
  useBoundTurnId(message.clientId);
  // History reloads replace the message object; the wait reads the newest one.
  const messageRef = useRef(message);
  messageRef.current = message;
  const bookmarks = useChatBookmarks(projectName, sessionId);
  const toggle = useSessionBookmarks((s) => s.toggle);
  const [waiting, setWaiting] = useState(false);
  const turnId = knownTurnId(message);
  const marked = !!turnId && !!bookmarks?.some((b) => b.turnId === turnId);

  const save = (id: string) => void toggle(projectName, sessionId, { turnId: id, turnN: message.turnN, label: bookmarkLabelOf(text) });
  const onClick = () => {
    if (turnId) return save(turnId);
    if (waiting) return;
    setWaiting(true);
    void resolveTurnId(() => messageRef.current, { projectName, sessionId, providerId }).then((id) => {
      setWaiting(false);
      if (id) save(id);
      else toast.error("Couldn't get this turn's id yet");
    });
  };

  return (
    <ActionButton
      icon={waiting ? <Loader2 className="size-3.5 animate-spin" /> : <Bookmark className={marked ? "size-3.5 text-primary" : "size-3.5"} />}
      label={marked ? "Bookmarked" : "Bookmark"}
      title={marked ? "Remove this turn's bookmark" : "Bookmark this turn (··· → Bookmarks)"}
      onClick={onClick}
      standardSize
      iconOnlyBelowMd
    />
  );
}
