import { useEffect } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { useOnboardingStore } from "@/stores/onboarding-store";
import type { SessionListResponse } from "../../../types/chat";

/** Revalidate a restored history target without opening or sending any chat. */
export function useOnboardingSessionCheck(setNotice: (message: string) => void): void {
  const { status, currentStep, projectName, sessionId } = useOnboardingStore();
  useEffect(() => {
    if (status !== "active" || currentStep !== "history" || !projectName || !sessionId) return;
    let cancelled = false;
    const check = async () => {
      let offset = 0;
      for (let page = 0; page < 10; page++) {
        const result = await api.get<SessionListResponse>(`${projectUrl(projectName)}/chat/sessions?limit=100&offset=${offset}`);
        if (cancelled || result.sessions.some((session) => session.id === sessionId)) return;
        if (!result.hasMore) {
          useOnboardingStore.setState((state) => state.status === "active" && state.sessionId === sessionId && state.currentStep === "history" ? {
            currentStep: "chat", sessionId: null, attempt: null,
            completed: state.completed.filter((id) => id === "project"), skipped: [],
          } : {});
          setNotice("That conversation is no longer available. Open a chat to try again, or skip this step.");
          return;
        }
        offset += result.sessions.filter((session) => !session.pinned).length;
      }
      if (!cancelled) setNotice("Open chat history to find the conversation, or skip this step.");
    };
    void check().catch(() => { if (!cancelled) setNotice("History could not be checked. Try the history menu again when connected, or pause the tour."); });
    return () => { cancelled = true; };
  }, [status, currentStep, projectName, sessionId, setNotice]);
}
