/**
 * The morning digest in the stream: one line ("Morning digest · 3 projects, 4 items") that opens
 * into the per-project lists, so a quiet morning does not push the conversation off screen.
 */
import { useState } from "react";
import { ChevronDown, Coffee } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { AssistantCard } from "../../../../shared/assistant-cards";
import { cardTime } from "./card-shell";
import { DigestCard, digestProjects, digestSummary } from "./digest-card";

export function DigestFold({ card, defaultOpen = false }: { card: AssistantCard; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const summary = digestSummary(digestProjects(card));
  return (
    <div className="w-full space-y-2" data-digest-fold={open ? "open" : "closed"}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 rounded-[10px] border border-border bg-surface/60 px-3 text-left text-xs text-text-secondary hover:bg-surface-elevated md:min-h-9"
      >
        <Coffee className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate"><b className="font-medium text-text-primary">Morning digest</b> · {summary}</span>
        <time className="ml-auto shrink-0 text-[11px] text-text-subtle">{cardTime(card.createdAt)}</time>
        <span className="shrink-0 text-text-subtle">{open ? "Fold" : "Open"}</span>
        <ChevronDown className={cn("size-3.5 shrink-0 text-text-subtle transition-transform", open && "rotate-180")} />
      </button>
      {open && <DigestCard card={card} />}
    </div>
  );
}
