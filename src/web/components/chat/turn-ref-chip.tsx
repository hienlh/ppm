/**
 * A reference to one turn of another chat session, as a chip: the provider's icon, the session's
 * title, "Turn N", and the project's name when it is not the one being looked at.
 *
 * The bubble variant is drawn straight from the message's own block, so it costs no request and
 * has the same size on every render. The composer variant also shows a chip still loading (a
 * skeleton of the same size) and one whose turn is gone, which can only be removed.
 *
 * A tap opens the session; a mouse gets a tooltip, and a long press a preview sheet.
 */
import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { TriangleAlert, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TurnReference } from "../../../shared/chat-turn-ref";
import type { ComposerTurnChip } from "@/hooks/use-composer-turn-refs";
import { openTurnRef } from "@/lib/open-turn-ref";
import { ProviderBadge } from "./provider-selector";
import { TurnRefPreviewSheet } from "./turn-ref-preview-sheet";
import { TOOLS_OFF_WARNING, turnRefTime } from "./turn-ref-chip-text";

const LONG_PRESS_MS = 400;
const MOVE_TOLERANCE_PX = 10;
/** Every chip is this tall, loaded or not, so nothing around it moves. */
const CHIP_BOX = "h-[44px] md:h-7 max-w-[18rem] rounded-md border text-xs";

/** One chip; `onRemove` gives it a remove button (the composer only). */
export function TurnRefChip({ chip, currentProject, toolsOff, onRemove }: {
  chip: ComposerTurnChip;
  currentProject?: string;
  toolsOff?: boolean;
  onRemove?: () => void;
}) {
  const remove = onRemove && (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onRemove(); }}
      aria-label="Remove turn reference"
      title="Remove"
      className="flex size-[44px] shrink-0 items-center justify-center rounded-md text-text-subtle hover:text-text-primary md:size-7"
    >
      <X className="size-3.5" />
    </button>
  );
  if (chip.status === "loading") {
    return (
      <span data-turn-chip="loading" aria-label="Loading turn" className={cn(CHIP_BOX, "inline-flex w-48 items-center gap-2 border-border/60 bg-surface/60 pl-2")}>
        <span className="size-4 shrink-0 animate-pulse rounded bg-text-subtle/20" />
        <span className="h-2.5 flex-1 animate-pulse rounded bg-text-subtle/20" />
        {remove}
      </span>
    );
  }
  if (chip.status === "error") {
    return (
      <span data-turn-chip="error" title={chip.reason} className={cn(CHIP_BOX, "inline-flex items-center gap-1.5 border-error/40 bg-error/10 pl-2 text-error")}>
        <TriangleAlert className="size-3.5 shrink-0" />
        <span className="truncate">{chip.reason}</span>
        {remove}
      </span>
    );
  }
  return <TurnRefChipView refData={chip.ref} currentProject={currentProject} toolsOff={toolsOff} trailing={remove} />;
}

/** The ready chip: what both the composer and the sent bubble show. */
export function TurnRefChipView({ refData, currentProject, toolsOff, trailing }: {
  refData: TurnReference;
  currentProject?: string;
  toolsOff?: boolean;
  trailing?: ReactNode;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const showProject = !!currentProject && refData.projectName !== currentProject;
  const open = () => { void openTurnRef(refData); };

  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => disarm, []);
  const onTouchStart = (e: TouchEvent) => {
    const touch = e.touches?.[0];
    origin.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    pressed.current = false;
    disarm();
    timer.current = setTimeout(() => { pressed.current = true; setSheetOpen(true); }, LONG_PRESS_MS);
  };
  const onTouchMove = (e: TouchEvent) => {
    const touch = e.touches?.[0];
    if (!touch || !origin.current) return;
    if (Math.hypot(touch.clientX - origin.current.x, touch.clientY - origin.current.y) > MOVE_TOLERANCE_PX) disarm();
  };

  return (
    <span data-turn-chip="ready" className={cn(CHIP_BOX, "inline-flex items-center border-primary/30 bg-primary/10 text-text-primary")}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              // The click that ends a long press belongs to the sheet it opened.
              if (pressed.current) { pressed.current = false; return; }
              open();
            }}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            // A press that opened the sheet ends without a click on the chip under the finger.
            onTouchEnd={(e) => { if (pressed.current) e.preventDefault(); disarm(); }}
            // The browser took the gesture for a scroll: no further touch event will come.
            onTouchCancel={disarm}
            onContextMenu={(e) => { if (timer.current || pressed.current) e.preventDefault(); }}
            className="flex h-full min-w-0 select-none items-center gap-1.5 px-2 text-left"
          >
            <ProviderBadge providerId={refData.providerId} />
            <span className="min-w-0 truncate font-medium">{refData.title}</span>
            <span className="shrink-0 text-text-subtle">Turn {refData.n}</span>
            {showProject && <span className="max-w-[6rem] shrink-0 truncate text-text-subtle">· {refData.projectName}</span>}
            {toolsOff && <TriangleAlert aria-label={TOOLS_OFF_WARNING} className="size-3.5 shrink-0 text-warning" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          {refData.prompt && <p className="line-clamp-3 whitespace-pre-wrap break-words">{refData.prompt}</p>}
          <p className="opacity-70">{turnRefTime(refData.at)}</p>
          {toolsOff && <p className="mt-1">{TOOLS_OFF_WARNING}</p>}
        </TooltipContent>
      </Tooltip>
      {trailing}
      <TurnRefPreviewSheet
        refData={refData}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onOpen={open}
        showProject={showProject}
        toolsOff={toolsOff}
      />
    </span>
  );
}

/** The chips a sent message carries, read from its block. */
export function TurnRefChipRow({ refs, currentProject }: { refs: readonly TurnReference[]; currentProject?: string }) {
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5" data-turn-refs="">
      {refs.map((ref) => (
        <TurnRefChipView key={`${ref.providerId}/${ref.sessionId}/${ref.turnId}`} refData={ref} currentProject={currentProject} />
      ))}
    </div>
  );
}
