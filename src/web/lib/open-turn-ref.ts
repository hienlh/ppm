/**
 * What clicking a turn chip does: show the referenced session — in its own tab, focusing the one
 * already open; another project's in a floating window on a desktop, through the project switch on
 * a phone (`openChatSession`) — and ask that chat to bring the turn on screen.
 */
import { toast } from "sonner";
import { useTabStore } from "@/stores/tab-store";
import { canonicalSessionId, useChatJumpStore } from "@/stores/chat-jump-store";
import { openChatSession } from "./open-chat-session";
import type { TurnReference } from "../../shared/chat-turn-ref";

export async function openTurnRef(ref: Pick<TurnReference, "projectName" | "providerId" | "sessionId" | "turnId" | "title">): Promise<void> {
  // A tab that has since adopted its provider's id is the one to focus, not a second tab.
  const sessionId = canonicalSessionId(ref.sessionId);
  const jump = () => useChatJumpStore.getState().jump({ sessionId, turnId: ref.turnId });
  let jumped = false;
  const openHere = () => {
    // The chat takes it up once the tab is shown and its history has loaded.
    jump();
    jumped = true;
    useTabStore.getState().openTab({
      type: "chat",
      title: ref.title || "Chat",
      projectId: ref.projectName,
      closable: true,
      metadata: { projectName: ref.projectName, sessionId, providerId: ref.providerId },
    });
    return true;
  };
  // Another project's chat is asked only once it is shown: pulling that project's layout from the
  // server can take a while over a tunnel, and none of that should count against the jump's wait.
  if (!(await openChatSession({ ...ref, sessionId }, openHere))) {
    toast.error(`Project "${ref.projectName}" is not in this PPM`);
    return;
  }
  if (!jumped) jump();
}
