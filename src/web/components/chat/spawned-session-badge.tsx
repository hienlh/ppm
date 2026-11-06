/**
 * The mark on a session another session's AI created. A mouse gets "Created by <parent>" on hover
 * and opens the parent with a click; a touch screen opens a sheet with the same line and an Open
 * button in the thumb zone. Nothing is behind a hover alone.
 */
import { useState } from "react";
import { ExternalLink, GitBranch } from "@/lib/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { usePrefersCoarsePointer } from "@/components/os-explorer/use-coarse-long-press";
import { useSessionListStore } from "@/stores/session-list-store";
import { openLinkedSession } from "@/lib/session-collab-client";
import type { SessionInfo } from "../../../types/chat";

export function createdByText(parentTitle: string | null | undefined): string {
  return `Created by ${parentTitle?.trim() || "another session"}`;
}

export function SpawnedSessionBadge({ session, projectName }: { session: SessionInfo; projectName: string }) {
  const parentId = session.spawnedBy;
  const coarse = usePrefersCoarsePointer();
  const [sheetOpen, setSheetOpen] = useState(false);
  // The parent's provider, when the list holds it; a created session shares its creator's by default.
  const parent = useSessionListStore((s) => {
    if (!parentId) return undefined;
    for (const entry of Object.values(s.byProject)) {
      const hit = entry.sessions.find((x) => x.id === parentId);
      if (hit) return hit;
    }
    return undefined;
  });
  if (!parentId) return null;

  const label = createdByText(session.parentTitle ?? parent?.title);
  const openParent = () => void openLinkedSession({
    projectName,
    providerId: parent?.providerId ?? session.providerId,
    sessionId: parentId,
    title: session.parentTitle ?? parent?.title,
  });

  const icon = (
    <button
      type="button"
      data-spawned-badge={parentId}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        if (coarse) setSheetOpen(true);
        else openParent();
      }}
      // The icon stays small in a dense row; its hit area reaches 44px on a touch screen.
      className="relative inline-flex size-5 shrink-0 items-center justify-center rounded text-info before:absolute before:-inset-3 before:content-[''] md:before:-inset-1 can-hover:hover:bg-info/10"
    >
      <GitBranch className="size-3.5" />
    </button>
  );

  return (
    <>
      {coarse ? icon : (
        <Tooltip>
          <TooltipTrigger asChild>{icon}</TooltipTrigger>
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
      )}
      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
        <div className="space-y-3 px-4 pb-2 pt-1 text-sm" onClick={(e) => e.stopPropagation()}>
          <p className="flex items-center gap-2 text-text-primary">
            <GitBranch className="size-4 shrink-0 text-info" />
            <span className="min-w-0 break-words">{label}</span>
          </p>
          <p className="text-xs text-text-subtle">An AI in that session created this one. You can open, chat into and stop either.</p>
          <button
            type="button"
            onClick={() => { setSheetOpen(false); openParent(); }}
            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 text-sm font-medium text-primary-foreground"
          >
            <ExternalLink className="size-4" />
            Open the session that created it
          </button>
        </div>
      </BottomSheet>
    </>
  );
}
