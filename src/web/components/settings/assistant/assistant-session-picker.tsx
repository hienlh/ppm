/**
 * "Main session": which Assistant session Telegram follows and the Assistant window opens on.
 * Only a Claude session may be it for now, so only Claude sessions are listed; a Codex session
 * still appears in the list below for one-off use. Choosing one calls `PUT /main-session`; the
 * pick shows once the server announces it, so another device's change lands here too.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setMainSession } from "@/lib/assistant-settings-client";
import { MANAGER_PROVIDER_ID } from "../../../../shared/assistant-managers";
import type { SessionInfo } from "../../../../types/chat";

const NONE = "__none__";

/** "10/11" from a session's creation time; empty when it has none. */
export function shortDate(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });
}

/** `{title} · since {date}`, the label a main-session choice carries. */
export function mainSessionLabel(session: Pick<SessionInfo, "title" | "createdAt">): string {
  const since = shortDate(session.createdAt);
  return `${session.title || "Untitled session"}${since ? ` · since ${since}` : ""}`;
}

export function AssistantSessionPicker({ sessions, mainSessionId }: { sessions: SessionInfo[]; mainSessionId: string | null }) {
  const [saving, setSaving] = useState(false);
  const claude = sessions.filter((s) => s.providerId === MANAGER_PROVIDER_ID);
  // The main session may sit past the list's first page: it still has to be choosable as itself.
  const missing = mainSessionId && !claude.some((s) => s.id === mainSessionId);

  const choose = async (sessionId: string) => {
    if (sessionId === NONE || sessionId === mainSessionId) return;
    setSaving(true);
    try {
      await setMainSession(sessionId);
      toast.success("Main session changed", { description: "Telegram follows it from the next message." });
    } catch (e) {
      toast.error("Could not change the main session", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Select value={mainSessionId ?? NONE} disabled={saving} onValueChange={(v) => void choose(v)}>
      <SelectTrigger aria-label="Main session" className="h-11 w-full min-w-0 @[520px]:w-72 md:h-9" data-testid="assistant-main-session">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {!mainSessionId && <SelectItem value={NONE} disabled>No main session</SelectItem>}
        {missing && mainSessionId && <SelectItem value={mainSessionId}>Main session</SelectItem>}
        {claude.map((s) => <SelectItem key={s.id} value={s.id}>{mainSessionLabel(s)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
