/**
 * Properties for one entry, read fresh from `/api/fs/stat` rather than from the listing:
 * the listing has no permissions, no symlink target and no child count, and it may be
 * seconds old.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { fsApi, type FsEntry, type FsStatResult } from "@/lib/fs-api";
import { Button } from "@/components/ui/button";
import { ExplorerModalShell } from "./explorer-modal-shell";
import { dirnameOf, formatDateTime, formatMode, formatSize } from "./format-file-meta";

const KIND_LABEL: Record<FsStatResult["kind"], string> = {
  file: "File",
  directory: "Folder",
  symlink: "Symbolic link",
  unknown: "Unknown",
};

function Row({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 py-1 text-sm">
      <span className="text-text-2">{label}</span>
      <span className="break-all text-text">{value}</span>
    </div>
  );
}

export interface PropertiesDialogProps {
  entry: FsEntry;
  platform: string | undefined;
  sep: string;
  onClose(): void;
}

export function PropertiesDialog({ entry, platform, sep, onClose }: PropertiesDialogProps) {
  const [stat, setStat] = useState<FsStatResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setStat(null);
    setError(null);
    fsApi
      .stat(entry.path, controller.signal)
      .then((result) => { if (alive) setStat(result); })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "Could not read properties");
      });
    return () => { alive = false; controller.abort(); };
  }, [entry.path]);

  const sizeLabel = stat
    ? stat.kind === "directory"
      ? `${stat.childCount ?? 0}${stat.truncated ? "+" : ""} item${stat.childCount === 1 ? "" : "s"}`
      : `${formatSize(stat.size)} (${stat.size.toLocaleString()} bytes)`
    : "";

  // Windows does not encode write permission in the mode bits, so the read-only flag is
  // the meaningful answer there and the octal is the meaningful one everywhere else.
  const permissions = stat
    ? platform === "win32"
      ? (stat.readonly ? "Read-only" : "Read / write")
      : `${formatMode(stat.mode)}${stat.readonly ? " (read-only)" : ""}`
    : "";

  return (
    <ExplorerModalShell
      open
      onClose={onClose}
      title={entry.name}
      description="Properties"
      footer={<Button variant="outline" onClick={onClose}>Close</Button>}
    >
      {error && <p className="py-2 text-sm text-error">{error}</p>}
      {!stat && !error && (
        <div className="flex items-center gap-2 py-4 text-sm text-text-2">
          <Loader2 className="size-4 animate-spin" /> Reading…
        </div>
      )}
      {stat && (
        <div className="divide-y divide-border">
          <Row label="Name" value={stat.name} />
          <Row label="Kind" value={KIND_LABEL[stat.kind]} />
          <Row label="Location" value={dirnameOf(stat.path, sep)} />
          <Row label={stat.kind === "directory" ? "Contains" : "Size"} value={sizeLabel} />
          <Row label="Created" value={formatDateTime(stat.birthtime)} />
          <Row label="Modified" value={formatDateTime(stat.mtime)} />
          <Row label="Permissions" value={permissions} />
          <Row label="Hidden" value={stat.isHidden ? "Yes" : ""} />
          <Row label="Links to" value={stat.target ?? ""} />
        </div>
      )}
    </ExplorerModalShell>
  );
}
