import { Bot } from "lucide-react";
import { SessionListPanel } from "./session-list-panel";
import type { SessionInfo } from "../../../types/chat";

interface ChatWelcomeProps {
  projectName: string;
  onSelectSession: (session: SessionInfo) => void;
}

export function ChatWelcome({ projectName, onSelectSession }: ChatWelcomeProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 text-text-secondary overflow-y-auto">
      <div className="flex flex-col items-center gap-3">
        <Bot className="size-10 text-text-subtle" />
        <p className="text-sm">Send a message to start a new conversation</p>
      </div>

      <SessionListPanel
        projectName={projectName}
        onSelectSession={onSelectSession}
        className="w-full px-4"
      />
    </div>
  );
}
