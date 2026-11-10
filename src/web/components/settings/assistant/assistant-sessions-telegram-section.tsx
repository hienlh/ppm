/**
 * Settings → PPM Assistant → Sessions & Telegram: the main session (the one Telegram follows),
 * a new one-off session, every Assistant session with Open / Set as main / Delete, and the
 * Assistant's Telegram bot below.
 */
import { toast } from "sonner";
import { Pin, Send } from "@/lib/icons";
import { api, projectUrl } from "@/lib/api-client";
import { setMainSession } from "@/lib/assistant-settings-client";
import { useAssistantMainSession } from "@/hooks/use-assistant-main-session";
import { useAssistantProviders, useAssistantSessions } from "@/hooks/use-assistant-sessions";
import { commitOptimistic, useSessionListStore } from "@/stores/session-list-store";
import { projectRefForName } from "@/stores/session-list-sync-triggers";
import { openAssistant, openAssistantNewSession } from "@/components/assistant/open-assistant";
import { ASSISTANT_PROJECT_NAME } from "../../../../shared/assistant-project";
import type { SessionInfo } from "../../../../types/chat";
import { AssistantTelegramSettings } from "../assistant-telegram-settings";
import { SettingLine, SettingsCard } from "./assistant-settings-card";
import { AssistantSessionPicker } from "./assistant-session-picker";
import { AssistantNewSession, AssistantSessionList } from "./assistant-session-list";

export const TELEGRAM_FOLLOWS_MAIN = "Telegram follows the main session.";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AssistantSessionsTelegramSection() {
  const main = useAssistantMainSession();
  const { providers } = useAssistantProviders();
  const { sessions } = useAssistantSessions();

  const setMain = async (session: SessionInfo) => {
    try {
      await setMainSession(session.id);
      toast.success("Main session changed");
    } catch (e) {
      toast.error("Could not change the main session", { description: errorText(e) });
    }
  };

  const remove = async (session: SessionInfo) => {
    const ref = projectRefForName(ASSISTANT_PROJECT_NAME);
    useSessionListStore.getState().removeSession(ref, session.id);
    const ok = await commitOptimistic(ref, () =>
      api.del(`${projectUrl(ASSISTANT_PROJECT_NAME)}/chat/sessions/${encodeURIComponent(session.id)}?providerId=${encodeURIComponent(session.providerId)}`));
    if (!ok) toast.error("Could not delete the session");
  };

  return (
    <div className="space-y-4" data-testid="assistant-sessions-section">
      <SettingsCard icon={Pin} title="Sessions">
        <SettingLine label="Main session" note="Reports, decisions and the morning digest arrive here. Claude sessions only for now.">
          <AssistantSessionPicker sessions={sessions} mainSessionId={main.sessionId} />
        </SettingLine>
        <SettingLine label="New session" note="A one-off session for something apart. The main session stays as it is.">
          {providers && providers.length > 0
            ? <AssistantNewSession providers={providers} onNew={openAssistantNewSession} />
            : <span className="text-xs text-text-subtle">No configured provider can run the Assistant.</span>}
        </SettingLine>
        <div className="px-1 py-1">
          <AssistantSessionList
            sessions={sessions}
            mainSessionId={main.sessionId}
            onOpen={(s) => openAssistant({ sessionId: s.id, providerId: s.providerId })}
            onSetMain={(s) => void setMain(s)}
            onDelete={(s) => void remove(s)}
          />
        </div>
      </SettingsCard>

      <SettingsCard icon={Send} title="Telegram" aside={<span>{TELEGRAM_FOLLOWS_MAIN}</span>}>
        <div className="p-3.5">
          <AssistantTelegramSettings embedded />
        </div>
      </SettingsCard>
    </div>
  );
}
