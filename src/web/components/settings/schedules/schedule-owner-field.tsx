/**
 * "Owned by": which chat of the project lists a script or prompt schedule in its footer chip. A
 * change is saved at once (`PATCH /api/schedules/:id/owner`, which refuses a chat of another
 * project) and every open PPM re-reads its schedules on the `schedules:changed` that follows. Used
 * in the Settings form and on the Schedules window's card. A session schedule has no such field:
 * the chat it sends into is its chat.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api-client";
import { useProjectChatOptions } from "./schedule-session-fields";

/** The Select's value for "no chat owns it" (a Select item cannot have an empty value). */
export const NO_OWNER = "__none__";

/**
 * A control with text: 28px on desktop, 26px on a phone (design guidelines, Button Heights; the
 * chat footer's `FOOTER_CHIP`). `data-[size=default]` restates it because the Select primitive sets
 * its own height under that selector, which outranks a plain `h-*`.
 */
export const OWNER_TRIGGER = "w-full h-7 data-[size=default]:h-7 max-md:h-[26px] max-md:data-[size=default]:h-[26px] px-2.5 max-md:px-[5px] py-0 text-[11.5px]";
/** Each chat in the list: one compact row, the same height as the field. */
export const OWNER_OPTION = "h-7 max-md:h-[26px] py-0 text-[11.5px]";

export function ScheduleOwnerField({ scheduleId, projectName, ownerId, ownerTitle, onChanged, compact }: {
  scheduleId: number;
  projectName: string | undefined;
  ownerId: string | null;
  /** The owning chat's title, for a chat no longer among the recent ones. */
  ownerTitle?: string | null;
  onChanged?: (ownerId: string | null) => void;
  /** No label or caption: the card around it says what it is. */
  compact?: boolean;
}) {
  const chats = useProjectChatOptions(projectName);
  const [value, setValue] = useState(ownerId ?? NO_OWNER);
  const [saving, setSaving] = useState(false);
  // Follow a change made elsewhere (another device, a chat claiming it): only when the prop itself
  // moves. Comparing it with the value shown instead would put the old owner back the moment a save
  // ends, before the list has re-read the schedule.
  const [lastProp, setLastProp] = useState(ownerId);
  if (ownerId !== lastProp) { setLastProp(ownerId); if (!saving) setValue(ownerId ?? NO_OWNER); }

  const options = chats ?? [];
  const missing = value !== NO_OWNER && !options.some((c) => c.id === value);

  const change = async (next: string) => {
    if (next === value) return;
    const previous = value;
    setValue(next);
    setSaving(true);
    try {
      const sessionId = next === NO_OWNER ? null : next;
      await api.patch(`/api/schedules/${scheduleId}/owner`, { sessionId });
      onChanged?.(sessionId);
      toast.success(sessionId ? "Its chat lists this schedule now" : "No chat lists this schedule now");
    } catch (e) {
      setValue(previous);
      toast.error(e instanceof Error ? e.message : "Could not change the owner");
    } finally {
      setSaving(false);
    }
  };

  const select = (
    <Select value={value} onValueChange={(v) => void change(v)} disabled={saving || !projectName}>
      <SelectTrigger aria-label="Owned by chat" data-schedule-owner={scheduleId} data-owner-place={compact ? "card" : "form"} className={OWNER_TRIGGER}>
        <SelectValue placeholder={chats === null ? "Loading chats…" : "No chat"} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_OWNER} className={OWNER_OPTION}>No chat</SelectItem>
        {missing && <SelectItem value={value} className={OWNER_OPTION}>{ownerTitle || "Its current chat"}</SelectItem>}
        {options.map((c) => <SelectItem key={c.id} value={c.id} className={OWNER_OPTION}>{c.title}</SelectItem>)}
      </SelectContent>
    </Select>
  );
  if (compact) return select;
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium">Owned by chat</span>
      {select}
      <p className="text-[11px] text-muted-foreground">
        That chat&apos;s footer lists this schedule. It changes nothing else, and is saved at once.
      </p>
    </div>
  );
}
