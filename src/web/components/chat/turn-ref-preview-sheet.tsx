/**
 * A turn chip's preview on a touch screen, opened by a long press: what the hover tooltip shows
 * on a desktop — the turn's first prompt line and when it was asked — plus a button that opens
 * the session, in the thumb zone.
 */
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { ExternalLink, TriangleAlert } from "@/lib/icons";
import type { TurnReference } from "../../../shared/chat-turn-ref";
import { ProviderBadge } from "./provider-selector";
import { TOOLS_OFF_WARNING, turnRefTime } from "./turn-ref-chip-text";

export function TurnRefPreviewSheet({ refData, open, onClose, onOpen, showProject, toolsOff }: {
  refData: TurnReference;
  open: boolean;
  onClose: () => void;
  onOpen: () => void;
  showProject: boolean;
  toolsOff?: boolean;
}) {
  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className="space-y-3 px-4 pb-2 pt-1 text-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex min-w-0 items-center gap-2">
          <ProviderBadge providerId={refData.providerId} />
          <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{refData.title}</span>
          <span className="shrink-0 text-xs text-text-subtle">Turn {refData.n}</span>
        </div>
        {showProject && <p className="text-xs text-text-subtle">Project: {refData.projectName}</p>}
        {refData.prompt && <p className="whitespace-pre-wrap break-words leading-relaxed text-text-secondary">{refData.prompt}</p>}
        <p className="text-xs text-text-subtle">{turnRefTime(refData.at)}</p>
        {toolsOff && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{TOOLS_OFF_WARNING}</span>
          </p>
        )}
        <button
          type="button"
          onClick={() => { onClose(); onOpen(); }}
          className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 text-sm font-medium text-primary-foreground"
        >
          <ExternalLink className="size-4" />
          Open session
        </button>
      </div>
    </BottomSheet>
  );
}
