/**
 * The fields only a session schedule has: which chat of the project it sends into, the time zone
 * its cron is read in, and whether it runs once. The chat is picked from the project's own chat
 * list and cannot change once the schedule exists (a schedule for another chat is a new one).
 */
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, projectUrl } from "@/lib/api-client";
import { deviceTimeZone } from "@/lib/client-timezone-reporter";
import { timezoneProblem } from "../../../../shared/session-schedule-input";
import type { SessionInfo, SessionListResponse } from "../../../../types/chat";
import { Field } from "./schedule-kind-fields";

/** How many of the project's chats the picker offers: the most recent ones, pinned first. */
const CHAT_LIMIT = 50;

interface ChatOption { id: string; title: string }

/** The chats a schedule may go into: a design's chat is left out, the server refuses it anyway. */
export function chatOptions(sessions: SessionInfo[]): ChatOption[] {
  return sessions
    .filter((s) => !s.designSlug)
    .map((s) => ({ id: s.id, title: s.title?.trim() || "Untitled chat" }));
}

export function SessionChatPicker({ projectName, value, onChange, disabled, currentTitle }: {
  projectName: string | undefined;
  value: string;
  onChange: (sessionId: string) => void;
  disabled?: boolean;
  /** The saved schedule's chat title, for a chat no longer among the recent ones. */
  currentTitle?: string | null;
}) {
  const [chats, setChats] = useState<ChatOption[] | null>(null);

  useEffect(() => {
    if (!projectName) { setChats([]); return; }
    let live = true;
    setChats(null);
    const params = new URLSearchParams({ limit: String(CHAT_LIMIT), offset: "0" });
    api.get<SessionListResponse>(`${projectUrl(projectName)}/chat/sessions?${params}`)
      .then((data) => { if (live) setChats(chatOptions(data?.sessions ?? [])); })
      .catch(() => { if (live) setChats([]); });
    return () => { live = false; };
  }, [projectName]);

  const options = chats ?? [];
  const missing = value && !options.some((c) => c.id === value);
  const placeholder = !projectName ? "Pick a project first" : chats === null ? "Loading chats…" : options.length ? "Select chat" : "No chats in this project";

  return (
    <Field label="Chat">
      <Select value={value} onValueChange={onChange} disabled={disabled || !projectName}>
        <SelectTrigger className="w-full min-h-11 md:min-h-9 text-xs"><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>
          {missing && <SelectItem value={value}>{currentTitle || "This schedule's chat"}</SelectItem>}
          {options.map((c) => <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>)}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">
        {disabled ? "A schedule stays with its chat; add a new schedule for another one." : "Sent into this chat on its own settings, once it is idle."}
      </p>
    </Field>
  );
}

export function SessionTimingFields({ timezone, recurring, onTimezone, onRecurring }: {
  timezone: string;
  recurring: boolean;
  onTimezone: (zone: string) => void;
  onRecurring: (recurring: boolean) => void;
}) {
  const problem = timezoneProblem(timezone.trim() || null);
  const device = deviceTimeZone();
  return (
    <>
      <Field label="Time zone (optional)">
        <Input
          value={timezone}
          onChange={(e) => onTimezone(e.target.value)}
          placeholder={device ? `e.g. ${device}` : "e.g. Europe/London"}
          aria-invalid={problem ? true : undefined}
          className="h-11 md:h-9 text-xs font-mono"
        />
        <p className={problem ? "text-[11px] text-error" : "text-[11px] text-muted-foreground"}>
          {problem ?? "Blank reads the cron in the PPM host's own time zone."}
        </p>
      </Field>
      <div className="flex items-center justify-between min-h-11">
        <div>
          <span className="text-xs font-medium">Run once</span>
          <p className="text-[11px] text-muted-foreground">Fires at the first match, then removes itself.</p>
        </div>
        <Switch checked={!recurring} onCheckedChange={(once) => onRecurring(!once)} aria-label="Run once" />
      </div>
    </>
  );
}
