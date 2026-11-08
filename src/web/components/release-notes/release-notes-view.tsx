/**
 * The release notes at a readable size: the recent CHANGELOG sections in a scrolling column,
 * the installed version marked. Shared by the desktop window and the phone's bottom sheet.
 *
 * Fetched on mount rather than handed over by the status-bar popover, so the window still has
 * its notes after a reload restores it with no popover in sight.
 */
import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "@/lib/icons";
import { fetchRecentChangelog, type ChangelogSection } from "@/lib/changelog";
import { useSettingsStore } from "@/stores/settings-store";
import { ReleaseNotesEntry } from "./release-notes-entry";

export const RELEASES_URL = "https://github.com/hienlh/ppm/releases";

/** Enough history to see what changed since a machine was last updated, without paging. */
const SECTIONS_SHOWN = 30;

export function ReleaseNotesView() {
  const installed = useSettingsStore((s) => s.version);
  const [notes, setNotes] = useState<ChangelogSection[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchRecentChangelog(SECTIONS_SHOWN)
      .then((s) => { if (alive) setNotes(s); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background font-sans" data-testid="release-notes-view">
      <div className="flex shrink-0 items-center gap-3 border-b border-border-soft px-5 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text">Release notes</div>
          {installed && <div className="font-mono text-xs text-text-3">PPM v{installed} installed</div>}
        </div>
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-text-2 transition-colors hover:text-text md:min-h-8"
        >
          <ExternalLink className="size-3.5" /> GitHub
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4 text-sm leading-relaxed">
        {notes === null && !failed ? (
          <span className="flex items-center gap-2 text-text-3">
            <Loader2 className="size-4 animate-spin" /> Loading release notes…
          </span>
        ) : failed || !notes?.length ? (
          <span className="text-text-3">Release notes could not be loaded. Open them on GitHub instead.</span>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {notes.map((s) => (
              <ReleaseNotesEntry
                key={s.version}
                version={s.version}
                date={s.date}
                body={s.body}
                size="comfortable"
                installed={s.version === installed}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
