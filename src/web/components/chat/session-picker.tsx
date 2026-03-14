import { Plus } from "lucide-react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import type { SessionInfo } from "../../../types/chat";

interface SessionPickerProps {
  sessions: SessionInfo[];
  activeSessionId: string | undefined;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function SessionPicker({ sessions, activeSessionId, onSelect, onNew }: SessionPickerProps) {
  const active = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 text-xs max-w-[140px] truncate">
            {active ? active.title || "Untitled" : "Sessions"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {sessions.length === 0 && (
            <DropdownMenuItem disabled>No sessions</DropdownMenuItem>
          )}
          {sessions.map((s) => (
            <DropdownMenuItem
              key={s.id}
              onClick={() => onSelect(s.id)}
              className="flex flex-col items-start gap-0"
            >
              <span className="font-medium truncate w-full">{s.title || "Untitled"}</span>
              <span className="text-[10px] text-muted-foreground">{formatDate(s.createdAt)}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onNew}>
            <Plus className="size-3.5 mr-1.5" />
            New Chat
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="ghost" size="icon" className="size-7" onClick={onNew} title="New Chat">
        <Plus className="size-3.5" />
      </Button>
    </div>
  );
}
