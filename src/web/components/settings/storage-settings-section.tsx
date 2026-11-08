/**
 * Settings → Storage: what PPM's own files take on disk. The app database and the backups are
 * shown read-only; the session trace and the Query Audit log carry their retention limits.
 * The Query Audit block is the former "Query Audit Log" pane, mounted here unchanged.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "@/lib/icons";
import { getStorageOverview } from "@/lib/api-settings";
import { formatBytes } from "@/lib/format-bytes";
import { formatRelativeDate } from "@/lib/format-date";
import { QueryAuditSection } from "./query-audit-section";
import { SectionHeader } from "./settings-rows";
import { StorageSessionTraceBlock } from "./storage-session-trace-block";
import type { StorageBackups, StorageOverview, StorageSessionTrace } from "../../../shared/storage-settings";

/** A label/value row; the value wraps anywhere because paths are one long unbreakable word. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 @[420px]:flex-row @[420px]:items-baseline @[420px]:gap-3">
      <dt className="shrink-0 text-xs text-muted-foreground @[420px]:w-28">{label}</dt>
      <dd className="min-w-0 break-all text-xs">{value}</dd>
    </div>
  );
}

function NewestBackup({ newest }: { newest: StorageBackups["newest"] }) {
  if (!newest) return <Fact label="Newest" value="None yet" />;
  const when = new Date(newest.mtimeMs);
  return <Fact label="Newest" value={`${newest.name} · ${formatRelativeDate(when.toISOString())} (${when.toLocaleString()})`} />;
}

export function StorageSettingsSection() {
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await getStorageOverview());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onTraceSaved = useCallback((sessionTrace: StorageSessionTrace) => {
    setOverview((prev) => (prev ? { ...prev, sessionTrace } : prev));
  }, []);

  return (
    <div className="@container space-y-6">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">Space PPM's own files take on this machine.</p>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh sizes"
          title="Refresh sizes"
          disabled={loading}
          onClick={() => void load()}
          className="size-8 cursor-pointer pointer-coarse:size-11"
        >
          <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </div>

      {!overview ? (
        loadError ? (
          <p className="text-xs text-destructive" role="alert">Could not load storage details: {loadError}</p>
        ) : (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        )
      ) : (
        <>
          <section className="space-y-3">
            <SectionHeader title="App database">Settings, projects, sessions and history (ppm.db, with its write-ahead log).</SectionHeader>
            <dl className="space-y-2">
              <Fact label="Size" value={formatBytes(overview.appDb.sizeBytes)} />
              <Fact label="File" value={overview.appDb.path} />
            </dl>
          </section>

          <section className="space-y-3">
            <SectionHeader title="Backups">Verified snapshots of {overview.backups.dbStem}.db, kept by an automatic schedule.</SectionHeader>
            <dl className="space-y-2">
              <Fact label="Snapshots" value={`${overview.backups.count.toLocaleString()} · ${formatBytes(overview.backups.totalBytes)}`} />
              <NewestBackup newest={overview.backups.newest} />
              {overview.backups.others.length > 0 && (
                <Fact
                  label="Other databases"
                  value={overview.backups.others
                    .map((o) => `${o.dbStem}.db: ${o.count.toLocaleString()} · ${formatBytes(o.totalBytes)}`)
                    .join(", ")}
                />
              )}
              <Fact label="Folder" value={overview.backups.dir} />
            </dl>
          </section>

          <section className="space-y-3">
            <SectionHeader title="Session trace">Every chat turn's inputs and events, kept for debugging.</SectionHeader>
            <StorageSessionTraceBlock trace={overview.sessionTrace} onSaved={onTraceSaved} />
          </section>
        </>
      )}

      {/* Independent of the overview: it has its own endpoint and keeps working if that one fails. */}
      <section className="space-y-3">
        <SectionHeader title="Query Audit">SQL history from the editor, the data grid and the CLI.</SectionHeader>
        <QueryAuditSection />
      </section>
    </div>
  );
}
