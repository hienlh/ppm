import { useEffect } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { usePanelStore } from "@/stores/panel-store";
import { openDesignTab } from "@/lib/design/open-design-tab";

/**
 * A plain chat tab that turns out to hold a design session hands itself over to that
 * design's tab.
 *
 * Every surface that opens a session as a chat — a notification, a link, a list that does
 * not know the session is a design one — would otherwise take it out of design mode: no
 * canvas, and a history the design tab no longer owns. Asking once per session here covers
 * all of them, including ones added later, instead of trusting each caller to route itself.
 * The design tab is opened first (in the same panel) so the panel is never left empty.
 */
export function useDesignSessionRedirect(input: {
  tabId?: string;
  sessionId: string | null;
  designSlug?: string;
  projectName?: string;
  providerId?: string;
}) {
  const { tabId, sessionId, designSlug, projectName, providerId } = input;
  useEffect(() => {
    if (!tabId || !sessionId || designSlug || !projectName) return;
    const panel = usePanelStore.getState().getPanelForTab(tabId);
    if (panel?.tabs.find((t) => t.id === tabId)?.type !== "chat") return;
    let cancelled = false;
    api.get<{ designSlug: string | null }>(`${projectUrl(projectName)}/chat/sessions/${encodeURIComponent(sessionId)}/design`)
      .then(({ designSlug: slug }) => {
        if (cancelled || !slug) return;
        const panelId = usePanelStore.getState().getPanelForTab(tabId)?.id;
        openDesignTab({ projectName, slug, sessionId, providerId, panelId });
        usePanelStore.getState().closeTab(tabId, panelId);
      })
      .catch(() => { /* an unknown session stays a plain chat */ });
    return () => { cancelled = true; };
  }, [tabId, sessionId, designSlug, projectName, providerId]);
}
