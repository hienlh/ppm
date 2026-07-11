import { useCallback } from "react";
import { Check, Pin, PinOff, Pencil, Trash2, Tag, Circle } from "lucide-react";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { api, projectUrl } from "@/lib/api-client";
import { useNotificationStore } from "@/stores/notification-store";
import type { SessionInfo, ProjectTag } from "../../../types/chat";

interface SessionContextMenuProps {
  session: SessionInfo;
  projectName: string;
  projectTags: ProjectTag[];
  children: React.ReactNode;
  onTogglePin: (e: React.MouseEvent, session: SessionInfo) => void;
  onStartEditing?: (session: SessionInfo, e: React.MouseEvent) => void;
  onDeleteSession?: (e: React.MouseEvent, session: SessionInfo) => void;
  onTagChanged: (sessionId: string, tag: { id: number; name: string; color: string } | null) => void;
}

export function SessionContextMenu({
  session, projectName, projectTags, children,
  onTogglePin, onStartEditing, onDeleteSession, onTagChanged,
}: SessionContextMenuProps) {
  const markUnread = useNotificationStore((s) => s.markUnread);
  const isUnread = useNotificationStore((s) => s.notifications.has(session.id));
  const assignTag = useCallback(async (tagId: number | null) => {
    try {
      if (tagId) {
        await api.patch(`${projectUrl(projectName)}/chat/sessions/${session.id}/tag`, { tagId });
        const tag = projectTags.find((t) => t.id === tagId);
        if (tag) onTagChanged(session.id, { id: tag.id, name: tag.name, color: tag.color });
      } else {
        await api.del(`${projectUrl(projectName)}/chat/sessions/${session.id}/tag`);
        onTagChanged(session.id, null);
      }
    } catch { /* silent */ }
  }, [session.id, projectName, projectTags, onTagChanged]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={(e) => onTogglePin(e as unknown as React.MouseEvent, session)}
        >
          {session.pinned ? <PinOff className="size-3.5 mr-2" /> : <Pin className="size-3.5 mr-2" />}
          {session.pinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        {!isUnread && (
          <ContextMenuItem onClick={() => markUnread(session.id, projectName, session.title)}>
            <Circle className="size-3.5 mr-2 fill-primary text-primary" />
            Mark as unread
          </ContextMenuItem>
        )}
        {onStartEditing && (
          <ContextMenuItem
            onClick={(e) => onStartEditing(session, e as unknown as React.MouseEvent)}
          >
            <Pencil className="size-3.5 mr-2" />
            Rename
          </ContextMenuItem>
        )}

        {projectTags.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Tag className="size-3.5 mr-2" />
              Set Tag
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {projectTags.map((tag) => (
                <ContextMenuItem key={tag.id} onClick={() => assignTag(tag.id)}>
                  <span className="size-2.5 rounded-full mr-2 shrink-0" style={{ backgroundColor: tag.color }} />
                  {tag.name}
                  {session.tag?.id === tag.id && <Check className="size-3 ml-auto" />}
                </ContextMenuItem>
              ))}
              {session.tag && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => assignTag(null)}>
                    Remove tag
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        {onDeleteSession && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-error focus:text-error"
              onClick={(e) => onDeleteSession(e as unknown as React.MouseEvent, session)}
            >
              <Trash2 className="size-3.5 mr-2" />
              Delete
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
