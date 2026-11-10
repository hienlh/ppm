/**
 * The head of a manager chat a phone opened from the Assistant: "‹ Assistant" (back to the
 * project the chip was tapped in, with the Assistant tab on screen), the chat's name, and once,
 * right after the switch, a note saying what happened. Renders nothing for any other chat.
 */
import { useEffect } from "react";
import { ChevronLeft } from "@/lib/icons";
import { patchTabMetadata } from "@/lib/patch-tab-metadata";
import { assistantReturnOf, switchedNote } from "./assistant-return";

/** How long the one-time note stays before it folds away. */
const NOTE_MS = 8000;

export function AssistantBackBar({ tabId, metadata }: { tabId: string; metadata?: Record<string, unknown> }) {
  const back = assistantReturnOf(metadata);
  const note = back !== null && metadata?.returnNote === true;
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => patchTabMetadata(tabId, { returnNote: undefined }), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note, tabId]);
  if (!back) return null;
  const project = typeof metadata?.projectName === "string" ? metadata.projectName : "";

  const goBack = () => {
    void import("./open-manager-chat").then(({ returnToAssistant }) => returnToAssistant(tabId, back));
  };
  return (
    <div className="shrink-0 border-b border-border" data-assistant-back="">
      <div className="flex min-h-[52px] items-center gap-2 px-1.5">
        <button
          type="button"
          onClick={goBack}
          className="inline-flex h-11 shrink-0 items-center gap-1 rounded-lg pl-1 pr-2 text-sm font-medium text-primary active:bg-accent-wash"
        >
          <ChevronLeft className="size-[18px]" />Assistant
        </button>
        <span className="min-w-0 truncate text-sm font-semibold">{project} · Manager</span>
      </div>
      {note && (
        <p className="mx-3 mb-2 rounded-lg border border-accent-wash-border bg-accent-wash px-2.5 py-2 text-xs leading-relaxed text-text-secondary" role="status">
          {switchedNote(project)}
        </p>
      )}
    </div>
  );
}
