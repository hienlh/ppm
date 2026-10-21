import { useCallback, useEffect, useState } from "react";
import { listDesignHistory } from "@/lib/design/api-designs";
import type { DesignSnapshotInfo, DesignSnapshotReason } from "../../../../shared/design-types";

/**
 * Which version a new link pins: "Current version" (the server snapshots now) or one from the
 * design's history. A native select, so a phone gets its own picker. The list is read while
 * the picker is mounted and follows `design:history_changed`.
 */

export const CURRENT_VERSION = "current";

const REASON: Record<DesignSnapshotReason, string> = {
  turn: "after an AI turn",
  "pre-restore": "before a restore",
  "before-edit": "before a canvas edit",
  manual: "saved",
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});

export function ShareVersionPicker({ projectName, slug, value, onChange, id }: {
  projectName: string;
  slug: string;
  value: string;
  onChange: (version: string) => void;
  id: string;
}) {
  const [items, setItems] = useState<DesignSnapshotInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listDesignHistory(projectName, slug)
      .then((list) => { setItems(Array.isArray(list) ? list : []); setError(null); })
      .catch((e: Error) => setError(e.message || "Could not load the history"));
  }, [projectName, slug]);

  useEffect(() => {
    load();
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ projectName?: string; slug?: string }>).detail;
      if (d?.projectName === projectName && d.slug === slug) load();
    };
    window.addEventListener("design:history_changed", onChanged);
    return () => window.removeEventListener("design:history_changed", onChanged);
  }, [load, projectName, slug]);

  // A pinned version that left the history (pruned) falls back to the current one.
  useEffect(() => {
    if (items && value !== CURRENT_VERSION && !items.some((s) => s.id === value)) onChange(CURRENT_VERSION);
  }, [items, value, onChange]);

  return (
    <div className="flex flex-col gap-1">
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}
        className="min-h-11 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary md:min-h-9">
        <option value={CURRENT_VERSION}>Current version (saved now)</option>
        {(items ?? []).map((s) => (
          <option key={s.id} value={s.id}>{when(s.createdAt)}, {REASON[s.reason] ?? s.reason}</option>
        ))}
      </select>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}
