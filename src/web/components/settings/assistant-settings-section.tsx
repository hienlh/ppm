import { useEffect, useState, type ComponentType } from "react";
import { cn } from "@/lib/utils";
import { ASSISTANT_SETTINGS_TABS, useAssistantSettingsTab, type AssistantSettingsTabId } from "./assistant-settings-tab-store";
import { AssistantGeneralSettings } from "./assistant-general-settings";
import { AssistantSessionsTelegramSection } from "./assistant/assistant-sessions-telegram-section";
import { AssistantDigestQuietSection } from "./assistant/assistant-digest-quiet-section";
import { AssistantManagerChatsSection } from "./assistant/assistant-manager-chats-section";
import { AssistantNotebookSection } from "./assistant/assistant-notebook-section";

const PANELS: Record<AssistantSettingsTabId, ComponentType> = {
  general: AssistantGeneralSettings,
  sessions: AssistantSessionsTelegramSection,
  digest: AssistantDigestQuietSection,
  managers: AssistantManagerChatsSection,
  notebook: AssistantNotebookSection,
};

/**
 * Settings → PPM Assistant, in sub-tabs: General (what sessions run with), Sessions & Telegram,
 * Digest & quiet hours, Manager chats and Notebook. Each panel stays mounted once shown, so
 * switching away and back keeps an unsaved draft instead of reloading over it.
 *
 * The pane is a container of its own: the manager table and the rows below it pick their layout
 * from the pane's width, never the viewport's, since a narrow Settings window is not a phone.
 */
export function AssistantSettingsSection() {
  const tab = useAssistantSettingsTab((s) => s.tab);
  const setTab = useAssistantSettingsTab((s) => s.setTab);
  const [shown, setShown] = useState<ReadonlySet<AssistantSettingsTabId>>(() => new Set([tab]));
  useEffect(() => {
    setShown((prev) => (prev.has(tab) ? prev : new Set([...prev, tab])));
  }, [tab]);

  return (
    <div className="@container space-y-5" data-testid="assistant-settings" data-tab={tab}>
      <div role="tablist" aria-label="PPM Assistant settings" className="flex gap-1 overflow-x-auto border-b border-border/50">
        {ASSISTANT_SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`assistant-settings-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex min-h-11 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-t px-3 text-sm transition-colors md:min-h-9 md:text-xs",
              tab === t.id
                ? "border-b-2 border-primary font-medium text-primary"
                : "text-text-subtle hover:text-text-secondary",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {ASSISTANT_SETTINGS_TABS.map(({ id }) => {
        if (!shown.has(id) && tab !== id) return null;
        const Panel = PANELS[id];
        return <div key={id} role="tabpanel" hidden={tab !== id} data-panel={id}><Panel /></div>;
      })}
    </div>
  );
}
