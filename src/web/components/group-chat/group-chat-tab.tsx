import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Send, Square, Play, Users, Loader2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "@/stores/project-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useGroupChat } from "@/hooks/use-group-chat";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { cn } from "@/lib/utils";
import { GroupMessageItem } from "./group-message-item";
import { GroupMemberRoster } from "./group-member-roster";
import { GroupMemberEditDialog, type MemberFormValues } from "./group-member-edit-dialog";
import { GroupFullTranscriptView } from "./group-full-transcript-view";
import { getGroup, addGroupMember, updateGroupMember, removeGroupMember, updateGroupSettings } from "@/lib/api-group-chat";
import type { GroupMessage, GroupMember } from "../../../types/group-chat";

interface GroupChatTabProps {
  metadata?: Record<string, unknown>;
}

export function GroupChatTab({ metadata }: GroupChatTabProps) {
  const groupId = (metadata?.groupId as string | undefined) ?? null;
  const { activeProject } = useProjectStore(useShallow((s) => ({ activeProject: s.activeProject })));
  const projectName = (metadata?.projectName as string | undefined) ?? activeProject?.name ?? "";
  const isMobile = useIsMobile();

  const {
    messages, members, status, typing, loading, isRunning, error,
    sendMessage, stop, resume,
  } = useGroupChat(groupId, projectName);

  const [draft, setDraft] = useState("");
  const [transcriptMsg, setTranscriptMsg] = useState<GroupMessage | null>(null);
  const [rosterOpen, setRosterOpen] = useState(false);
  const feedEndRef = useRef<HTMLDivElement>(null);

  // Full roster (with persona/model) for management — the WS `members` only carry
  // live status/color, so we fetch the editable detail separately and refetch on change.
  const [roster, setRoster] = useState<GroupMember[]>([]);
  const [cap, setCap] = useState<number | null>(null); // per-group reply-burst cap
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterError, setRosterError] = useState<string | null>(null);
  // `null` = dialog closed; `{ member: null }` = add; `{ member }` = edit.
  const [editing, setEditing] = useState<{ member: GroupMember | null } | null>(null);

  const reloadRoster = useCallback(async () => {
    if (!groupId) return;
    try { const g = await getGroup(groupId); setRoster(g.members); setCap(g.maxTurns); } catch { /* keep last */ }
  }, [groupId]);

  const handleCapChange = useCallback(async (n: number) => {
    if (!groupId) return;
    const clamped = Math.max(1, Math.min(50, Math.floor(n) || 1));
    setCap(clamped);
    try { await updateGroupSettings(groupId, { maxTurns: clamped }); }
    catch { void reloadRoster(); }
  }, [groupId, reloadRoster]);

  useEffect(() => { setRoster([]); void reloadRoster(); }, [groupId, reloadRoster]);

  // Stick to bottom on new messages.
  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, typing]);

  // memberId → live status from the running burst (overlays the fetched roster).
  const liveStatus = useMemo(() => new Map(members.map((m) => [m.id, m.status] as const)), [members]);

  // Prefer the fetched roster (fresh after edits); fall back to WS members before load.
  const metaSource = roster.length ? roster : members;
  const colorFor = useMemo(() => {
    const map = new Map(metaSource.map((m) => [m.name, m.color]));
    return (name: string) => map.get(name) ?? null;
  }, [metaSource]);

  const isLeader = useMemo(() => {
    const leaders = new Set(metaSource.filter((m) => m.role === "leader").map((m) => m.name));
    return (name: string) => leaders.has(name);
  }, [metaSource]);

  const handleSubmitMember = useCallback(async (values: MemberFormValues) => {
    if (!groupId) return;
    if (editing?.member) await updateGroupMember(groupId, editing.member.id, values);
    else await addGroupMember(groupId, values);
    await reloadRoster();
  }, [groupId, editing, reloadRoster]);

  const handleRemoveMember = useCallback(async (m: GroupMember) => {
    if (!groupId) return;
    setRosterBusy(true); setRosterError(null);
    try { await removeGroupMember(groupId, m.id); await reloadRoster(); }
    catch (e) { setRosterError(e instanceof Error ? e.message : "Failed to remove member"); }
    finally { setRosterBusy(false); }
  }, [groupId, reloadRoster]);

  const handleSend = useCallback(() => {
    const content = draft.trim();
    if (!content) return;
    sendMessage(content);
    setDraft("");
  }, [draft, sendMessage]);

  const typingNames = Object.keys(typing).filter((n) => typing[n]);

  if (!groupId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-text-subtle">
        No group selected.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Feed column */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className={cn(
              "size-2 rounded-full",
              status === "active" ? "bg-primary animate-pulse" : status === "paused" ? "bg-amber-500" : "bg-text-subtle",
            )} />
            <span className="capitalize">{status}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {isRunning ? (
              <Button size="sm" variant="outline" onClick={stop} className="h-8">
                <Square className="mr-1 size-3.5" /> Stop
              </Button>
            ) : status === "paused" ? (
              <Button size="sm" variant="outline" onClick={resume} className="h-8">
                <Play className="mr-1 size-3.5" /> Resume
              </Button>
            ) : null}
            <button
              type="button"
              onClick={() => setRosterOpen((v) => !v)}
              className="flex size-8 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-foreground"
              aria-label="Toggle roster"
            >
              <Users className="size-4" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center justify-center p-4 text-center text-sm text-text-subtle">
              Send a message to start the group.
            </div>
          ) : (
            <div className="flex flex-col py-2">
              {messages.map((m) => (
                <GroupMessageItem key={m.id} message={m} colorFor={colorFor} isLeader={isLeader} onViewFull={setTranscriptMsg} />
              ))}
              {typingNames.length > 0 && (
                <div className="px-3 py-1.5 text-xs italic text-text-subtle">
                  {typingNames.join(", ")} {typingNames.length === 1 ? "is" : "are"} typing…
                </div>
              )}
              <div ref={feedEndRef} />
            </div>
          )}
        </div>

        {error && (
          <div className="shrink-0 border-t border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {/* Input — primary action in thumb zone on mobile */}
        <div className="shrink-0 border-t border-border p-2">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !isMobile) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              rows={1}
              placeholder="Message the group…"
              className="max-h-32 min-h-[44px] flex-1 resize-none rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <Button
              onClick={handleSend}
              disabled={!draft.trim()}
              className="size-11 shrink-0 p-0"
              aria-label="Send"
            >
              <Send className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Roster — inline sidebar on desktop; bottom sheet on mobile (tap backdrop
          or swipe down to dismiss, since the header toggle sits under an overlay). */}
      {isMobile ? (
        <BottomSheet open={rosterOpen} onClose={() => setRosterOpen(false)} className="flex max-h-[72vh] flex-col">
          <div className="flex h-11 shrink-0 items-center px-4 text-sm font-medium text-foreground">
            Members
          </div>
          <div className="min-h-0 overflow-y-auto">
            {cap !== null && (
              <label className="flex items-center gap-2 px-4 py-2 text-xs text-text-secondary">
                <span>Reply cap</span>
                <input type="number" min={1} max={50} value={cap}
                  onChange={(e) => handleCapChange(Number(e.target.value))}
                  className="w-14 rounded border border-border bg-background px-1.5 py-1 text-xs text-foreground" />
                <span className="text-text-subtle">turns/msg</span>
              </label>
            )}
            {rosterError && <p className="px-3 py-1 text-xs text-destructive">{rosterError}</p>}
            <GroupMemberRoster
              members={roster} liveStatus={liveStatus} typing={typing} busy={rosterBusy}
              onAdd={() => setEditing({ member: null })} onEdit={(m) => setEditing({ member: m })} onRemove={handleRemoveMember}
            />
          </div>
        </BottomSheet>
      ) : (
        rosterOpen && (
          <div className="flex w-60 shrink-0 flex-col border-l border-border bg-panel">
            <div className="flex h-11 shrink-0 items-center border-b border-border px-3 text-sm font-medium text-foreground">
              Members
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {cap !== null && (
                <label className="flex items-center gap-2 px-3 py-2 text-xs text-text-secondary">
                  <span>Reply cap</span>
                  <input type="number" min={1} max={50} value={cap}
                    onChange={(e) => handleCapChange(Number(e.target.value))}
                    className="w-14 rounded border border-border bg-background px-1.5 py-1 text-xs text-foreground" />
                  <span className="text-text-subtle">turns/msg</span>
                </label>
              )}
              {rosterError && <p className="px-3 py-1 text-xs text-destructive">{rosterError}</p>}
              <GroupMemberRoster
                members={roster} liveStatus={liveStatus} typing={typing} busy={rosterBusy}
                onAdd={() => setEditing({ member: null })} onEdit={(m) => setEditing({ member: m })} onRemove={handleRemoveMember}
              />
            </div>
          </div>
        )
      )}

      {editing && (
        <GroupMemberEditDialog
          key={editing.member?.id ?? "add"}
          open
          member={editing.member}
          projectName={projectName}
          onSubmit={handleSubmitMember}
          onClose={() => setEditing(null)}
        />
      )}

      <GroupFullTranscriptView groupId={groupId} message={transcriptMsg} onClose={() => setTranscriptMsg(null)} />
    </div>
  );
}
