import { AlertCircle, ChevronUp, History, Loader2 } from "lucide-react";

/** Detects a JSONL transcript path in Claude's compact summary message text. */
const JSONL_PATH_RE = /read the full transcript at:\s*(\S+\.jsonl)/i;

export function extractJsonlPath(text: string): string | null {
  const match = text.match(JSONL_PATH_RE);
  return match?.[1]?.trim() ?? null;
}

export type PreCompactStatus = "idle" | "loading" | "loaded" | "error";

interface PreCompactButtonProps {
  status: PreCompactStatus;
  onLoad?: () => void;
  count?: number;
}

/**
 * Button shown when Claude's compact summary is detected.
 * Clicking triggers the pre-compact-messages fetch. Shows loading/loaded/error states.
 * Responsive: full-width on mobile, inline on desktop. Min 44px touch target.
 */
export function PreCompactButton({ status, onLoad, count }: PreCompactButtonProps) {
  const isBusy = status === "loading";
  const isLoaded = status === "loaded";
  const isError = status === "error";

  const label = isBusy
    ? "Loading previous conversation..."
    : isLoaded
      ? `Previous conversation loaded${count != null ? ` (${count})` : ""}`
      : isError
        ? "Failed to load — retry"
        : "Load previous conversation";

  const Icon = isBusy ? Loader2 : isLoaded ? ChevronUp : isError ? AlertCircle : History;

  return (
    <button
      type="button"
      onClick={onLoad}
      disabled={isBusy || isLoaded}
      className="mt-2 inline-flex items-center justify-center gap-2 rounded-md border border-border bg-surface/50 px-4 py-2.5 text-sm text-text-primary hover:bg-surface transition-colors disabled:opacity-70 disabled:cursor-default w-full md:w-auto min-h-[44px]"
    >
      <Icon className={`size-4 shrink-0 ${isBusy ? "animate-spin" : ""} ${isError ? "text-red-400" : ""}`} />
      <span>{label}</span>
    </button>
  );
}
