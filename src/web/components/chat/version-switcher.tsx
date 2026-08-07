import { ChevronLeft, ChevronRight } from "lucide-react";
import type { VersionGroup } from "../../../types/api";

/**
 * `‹ n/m ›` switcher shown on a user message that has edited versions.
 *
 * Purely presentational: the version group arrives with the message history
 * (`versionMap` on the /messages response), so there is no per-message request.
 * Renders nothing unless 2+ versions exist. Prev/next swap the tab to the
 * sibling session.
 */
export function VersionSwitcher({
  group,
  onNavigate,
  disabled,
}: {
  /** Version group for this message's ordinal; undefined when it has no edits. */
  group?: VersionGroup;
  onNavigate: (sessionId: string) => void;
  disabled?: boolean;
}) {
  if (!group || group.ids.length < 2) return null;

  const { ids, currentIndex } = group;
  const go = (idx: number) => {
    const target = ids[idx];
    if (target && !disabled) onNavigate(target);
  };

  return (
    <div className="mt-1 flex items-center gap-1 text-xs text-text-subtle select-none">
      <button
        type="button"
        onClick={() => go(currentIndex - 1)}
        disabled={disabled || currentIndex <= 0}
        aria-label="Previous version"
        className="flex items-center justify-center rounded p-0.5 hover:text-text-primary disabled:opacity-30 disabled:cursor-default"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="tabular-nums">{currentIndex + 1}/{ids.length}</span>
      <button
        type="button"
        onClick={() => go(currentIndex + 1)}
        disabled={disabled || currentIndex >= ids.length - 1}
        aria-label="Next version"
        className="flex items-center justify-center rounded p-0.5 hover:text-text-primary disabled:opacity-30 disabled:cursor-default"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  );
}
