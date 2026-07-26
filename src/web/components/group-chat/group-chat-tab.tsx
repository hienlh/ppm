import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Send, Square, Play, Users, Loader2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "@/stores/project-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useGroupChat } from "@/hooks/use-group-chat";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GroupMessageItem } from "./group-message-item";
import { GroupMemberRoster } from "./group-member-roster";
import { GroupFullTranscriptView } from "./group-full-transcript-view";
import type { GroupMessage } from "../../../types/group-chat";

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

  // Stick to bottom on new messages.
  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, typing]);

  const colorFor = useMemo(() => {
    const map = new Map(members.map((m) => [m.name, m.color]));
    return (name: string) => map.get(name) ?? null;
  }, [members]);

  const isLeader = useMemo(() => {
    const leaders = new Set(members.filter((m) => m.role === "leader").map((m) => m.name));
    return (name: string) => leaders.has(name);
  }, [members]);

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

      {/* Roster — sidebar on desktop, drawer toggle on mobile */}
      {rosterOpen && (
        <div className={cn(
          "shrink-0 border-l border-border bg-panel",
          isMobile ? "absolute inset-y-0 right-0 z-20 w-64 shadow-xl" : "w-60",
        )}>
          <div className="flex h-11 items-center border-b border-border px-3 text-sm font-medium text-foreground">
            Members
          </div>
          <GroupMemberRoster members={members} typing={typing} />
        </div>
      )}

      <GroupFullTranscriptView groupId={groupId} message={transcriptMsg} onClose={() => setTranscriptMsg(null)} />
    </div>
  );
}
