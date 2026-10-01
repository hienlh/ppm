/**
 * A drive's partitions — Mission Center's Partitions section.
 *
 * One row per partition, not per mount: a partition's usage belongs to its
 * FILESYSTEM, and a btrfs subvolume layout mounts one filesystem at seven places
 * that all report the same figures. Seven identical bars would be noise, so the
 * mount points are listed together above one bar.
 */
import { formatBytes } from "@/lib/format-bytes";
import { cn } from "@/lib/utils";
import type { PartitionInfo } from "../../../../types/system-hardware";

/** Above this a bar earns a warning colour — a filesystem this full is a problem
 *  worth noticing before it is one. */
const FULL_PERCENT = 90;
const BUSY_PERCENT = 75;

function barColor(percent: number): string {
  if (percent >= FULL_PERCENT) return "bg-error";
  if (percent >= BUSY_PERCENT) return "bg-warning";
  return "bg-primary";
}

export function PartitionList({ partitions }: { partitions: readonly PartitionInfo[] }) {
  if (partitions.length === 0) return null;
  return (
    <section className="space-y-2" data-testid="sysmon-partitions">
      <h4 className="text-sm font-medium">Partitions</h4>
      <ul className="space-y-2">
        {partitions.map((part) => (
          <PartitionRow key={part.id} part={part} />
        ))}
      </ul>
    </section>
  );
}

function PartitionRow({ part }: { part: PartitionInfo }) {
  // The first mount that answered: every mount of one filesystem reports the
  // same statfs, so there is nothing to choose between them.
  const usage = part.mounts.find((m) => m.usedBytes !== undefined && m.totalBytes);
  const percent = usage ? Math.min(100, (usage.usedBytes! / usage.totalBytes!) * 100) : undefined;

  return (
    <li className="rounded-md border border-border px-3 py-2 space-y-1.5" data-testid="sysmon-partition">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium truncate" title={part.devicePath}>{part.devicePath}</span>
        <span className="text-[11px] text-text-subtle shrink-0 tabular-nums">
          {part.filesystem ?? "—"} · {formatBytes(part.sizeBytes)}
        </span>
      </div>

      {part.mounts.length === 0 ? (
        <p className="text-[11px] text-text-subtle">Not mounted</p>
      ) : (
        <>
          <p className="text-[11px] text-text-subtle truncate" title={part.mounts.map((m) => m.mountPoint).join(", ")}>
            {part.mounts.map((m) => m.mountPoint).join(", ")}
          </p>
          {percent === undefined ? (
            // Mounted but statfs refused. An unreadable filesystem is not an
            // empty one, so it gets no bar rather than a bar at zero.
            <p className="text-[11px] text-text-subtle">Usage unavailable</p>
          ) : (
            <div className="space-y-1">
              <div className="h-1.5 w-full rounded-full bg-surface-hover overflow-hidden">
                <div className={cn("h-full rounded-full", barColor(percent))} style={{ width: `${percent}%` }} />
              </div>
              <div className="flex items-baseline justify-between gap-2 text-[11px] text-text-subtle tabular-nums">
                <span>{formatBytes(usage!.usedBytes!)} of {formatBytes(usage!.totalBytes!)}</span>
                <span>{percent.toFixed(0)}%</span>
              </div>
            </div>
          )}
        </>
      )}
    </li>
  );
}
