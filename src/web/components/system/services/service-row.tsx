/**
 * One unit in the Services list.
 *
 * The row's tap opens the details; the actions live in an adaptive context menu
 * (right-click on a mouse, long-press on a touch screen). The tap target is a
 * real button INSIDE the trigger, because the adaptive menu only suppresses the
 * click that follows a long press — it has no tap handler of its own.
 *
 * The row is a CSS grid on the same template as the header above it, so a cell
 * and its column name line up. Every figure it shows is `undefined` when this
 * host or this tick could not measure it, and renders as an em dash: a unit that
 * owns no processes is a real zero, a unit whose processes have not been sampled
 * yet is not.
 */
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { cn } from "@/lib/utils";
import { formatDiskCell } from "../process-row-format";
import { formatRam } from "@/lib/format-bytes";
import { serviceStatusText, serviceTone, type ServiceTone } from "./service-rows";
import { SERVICE_COLUMNS, SERVICE_ROW_GRID_CLASS, columnVisibilityClass } from "./service-columns";
import type { UnitResources } from "./service-resources";
import type { ServiceColumnKey } from "./service-columns";
import type { ServiceAction, ServiceInfo } from "../../../../types/system-services";
import { SERVICE_ACTIONS } from "../../../../types/system-services";

const TONE_CLASS: Record<ServiceTone, string> = {
  failed: "bg-error",
  running: "bg-success",
  busy: "bg-warning animate-pulse",
  idle: "bg-text-subtle/40",
};

const ACTION_LABELS: Record<ServiceAction, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  enable: "Enable at boot",
  disable: "Disable at boot",
};

/** Stopping something is destructive in the menu's sense; starting it is not. */
const DESTRUCTIVE: readonly ServiceAction[] = ["stop", "disable"];

/** Visibility per column key, taken from the same table the grid template is
 *  built from so a cell cannot be shown at a width that has no track for it. */
const CELL_CLASS: Record<ServiceColumnKey, string> = Object.fromEntries(
  SERVICE_COLUMNS.map((c) => [c.key, columnVisibilityClass(c)]),
) as Record<ServiceColumnKey, string>;

/** `undefined` is "not measured", never 0 — the rule every cell on this page
 *  follows, and the reason these are not `?? 0`. */
const ramCell = (mb?: number) => (mb === undefined ? "—" : formatRam(mb));
const pctCell = (pct: number | undefined, digits: number) =>
  pct === undefined ? "—" : `${pct.toFixed(digits)}%`;

function Cell({ column, children }: { column: ServiceColumnKey; children: React.ReactNode }) {
  return (
    <span className={cn("text-right text-[11px] tabular-nums text-text-subtle truncate", CELL_CLASS[column])}>
      {children}
    </span>
  );
}

export interface ServiceRowProps {
  service: ServiceInfo;
  /** Live roll-up over the unit's cgroup. Undefined = not measured this tick,
   *  which renders as em dashes rather than as an idle unit. */
  resources?: UnitResources;
  onOpen: (service: ServiceInfo) => void;
  onAction: (service: ServiceInfo, action: ServiceAction) => void;
}

export function ServiceRow({ service, resources, onOpen, onAction }: ServiceRowProps) {
  const tone = serviceTone(service);
  const allowed = SERVICE_ACTIONS.filter((a) => service.refused?.[a] === undefined);
  // Every reason is the same sentence when a unit is refused wholesale, so the
  // footer shows it once rather than repeating it per hidden item.
  const reason = SERVICE_ACTIONS.map((a) => service.refused?.[a]).find(Boolean);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="select-none">
          <button
            type="button"
            onClick={() => onOpen(service)}
            data-testid="sysmon-service-row"
            data-unit={service.unit}
            data-tone={tone}
            data-cpu={resources?.cpu}
            data-ram-mb={resources?.ramMB}
            className={cn(
              "w-full min-h-11 px-3 py-2 items-center text-left hover:bg-surface-hover transition-colors",
              SERVICE_ROW_GRID_CLASS,
            )}
          >
            <span className="flex items-center gap-2 min-w-0">
              <span className={cn("size-2 rounded-full shrink-0", TONE_CLASS[tone])} aria-hidden />
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm truncate">{service.unit}</span>
                  {/* Beside the name rather than in a column of its own: it is a
                      property of the unit file, not a measurement, and a ninth
                      track would cost the name column 60px on every row. */}
                  {service.enabled && (
                    <span className="shrink-0 text-[10px] px-1 py-px rounded bg-surface-hover text-text-subtle">
                      enabled
                    </span>
                  )}
                </span>
                <span className="block text-[11px] text-text-subtle truncate">
                  {service.description || serviceStatusText(service)}
                </span>
              </span>
            </span>
            <Cell column="pid">{service.mainPid ?? "—"}</Cell>
            <Cell column="cpu">{pctCell(resources?.cpu, 1)}</Cell>
            <Cell column="ram">{ramCell(resources?.ramMB)}</Cell>
            <Cell column="swap">{ramCell(resources?.swapMB)}</Cell>
            <Cell column="disk">{formatDiskCell(resources?.diskReadBps, resources?.diskWriteBps)}</Cell>
            <Cell column="gpu">{pctCell(resources?.gpuPct, 0)}</Cell>
            <Cell column="gpuMem">{ramCell(resources?.gpuMemMB)}</Cell>
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {allowed.map((action) => (
          <ContextMenuItem
            key={action}
            variant={DESTRUCTIVE.includes(action) ? "destructive" : undefined}
            onSelect={() => onAction(service, action)}
          >
            {ACTION_LABELS[action]}
          </ContextMenuItem>
        ))}
        {allowed.length > 0 && <ContextMenuSeparator />}
        <ContextMenuItem onSelect={() => onOpen(service)}>Details and log</ContextMenuItem>
        {reason && (
          <p className="px-2 py-1.5 text-[11px] text-text-subtle max-w-64">{reason}</p>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
