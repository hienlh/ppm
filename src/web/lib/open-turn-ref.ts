/**
 * What clicking a turn chip does: show the referenced session — in its own tab, focusing the one
 * already open, switching project first when it is another project's — and ask that chat to
 * bring the turn on screen.
 */
import { toast } from "sonner";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { canonicalSessionId, useChatJumpStore } from "@/stores/chat-jump-store";
import { openSessionAnywhere } from "./open-session-anywhere";
import type { TurnReference } from "../../shared/chat-turn-ref";

export async function openTurnRef(ref: Pick<TurnReference, "projectName" | "providerId" | "sessionId" | "turnId" | "title">): Promise<void> {
  // A tab that has since adopted its provider's id is the one to focus, not a second tab.
  const sessionId = canonicalSessionId(ref.sessionId);
  const jump = () => useChatJumpStore.getState().jump({ sessionId, turnId: ref.turnId });
  if (ref.projectName !== useProjectStore.getState().activeProject?.name) {
    // Asked only once the other project's layout is in: pulling it from the server can take a
    // while over a tunnel, and none of that should count against the jump's wait.
    if (!(await openSessionAnywhere(ref.projectName, sessionId, ref.providerId))) {
      toast.error(`Project "${ref.projectName}" is not in this PPM`);
      return;
    }
    jump();
    return;
  }
  // The chat takes it up once the tab is shown and its history has loaded.
  jump();
  useTabStore.getState().openTab({
    type: "chat",
    title: ref.title || "Chat",
    projectId: ref.projectName,
    closable: true,
    metadata: { projectName: ref.projectName, sessionId, providerId: ref.providerId },
  });
}
