/**
 * Full-screen mobile presentation of a teammate's work session.
 *
 * Hosts the same content component the desktop floating window uses, so the steps,
 * refresh and error states are shared code rather than a parallel mobile build.
 * Self-gated singleton, mounted once at the app root beside the other overlays.
 */

import { lazy, Suspense } from "react";
import { X } from "lucide-react";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useTeamMemberSheet } from "./use-open-team-member";

const TeamMemberWindowContent = lazy(() => import("./team-member-window-content"));

export function TeamMemberSheet() {
  const payload = useTeamMemberSheet((s) => s.payload);
  const close = useTeamMemberSheet((s) => s.close);
  if (!payload) return null;

  return (
    <BottomSheet open onClose={close} zIndex={45} className="flex h-[var(--sheet-vh)] flex-col p-0">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 shrink-0">
        <span className="truncate text-sm font-medium text-text-primary">
          Session — {payload.memberName}
        </span>
        <button
          type="button"
          onClick={close}
          className="ml-auto flex size-11 items-center justify-center rounded text-text-secondary hover:text-text-primary"
          aria-label="Close"
        >
          <X className="size-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <Suspense fallback={<div className="p-4 text-sm text-text-2">Loading…</div>}>
          {/* No floating window backs this sheet, so the id is only an identity for the content. */}
          <TeamMemberWindowContent
            id={`sheet-${payload.memberName}`}
            payload={payload as unknown as Record<string, unknown>}
          />
        </Suspense>
      </div>
    </BottomSheet>
  );
}
