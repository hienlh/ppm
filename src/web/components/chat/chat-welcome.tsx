import { Bot } from "@/lib/icons";
import { SessionListPanel } from "./session-list-panel";
import { OnboardingEntry } from "@/components/onboarding/onboarding-entry";
import { useSettingsStore } from "@/stores/settings-store";
import type { SessionInfo } from "../../../types/chat";

interface ChatWelcomeProps {
  projectName: string;
  onSelectSession: (session: SessionInfo) => void;
}

export function ChatWelcome({ projectName, onSelectSession }: ChatWelcomeProps) {
  // Minimal mode never mounts the onboarding tour, so its entry would open nothing.
  const minimalMode = useSettingsStore((s) => s.minimalMode);
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 text-text-secondary overflow-y-auto">
      <div className="flex flex-col items-center gap-3 px-4 w-full">
        <Bot className="size-10 text-text-subtle" />
        <p className="text-sm">Send a message to start a new conversation</p>
        {!minimalMode && <OnboardingEntry compact />}
      </div>

      <SessionListPanel
        projectName={projectName}
        onSelectSession={onSelectSession}
        className="w-full px-4"
      />
    </div>
  );
}
