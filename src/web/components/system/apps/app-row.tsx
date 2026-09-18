/**
 * One application in the Apps list.
 *
 * The icon is fetched from `/api/system/app-icon/<id>`, which resolves the app's
 * own desktop entry server-side — the URL names an app, never a file. An `<img>`
 * cannot send an Authorization header, so the token rides the query string the
 * same way the metrics stream's does; if it still fails the row falls back to a
 * letter tile rather than showing a broken image.
 */
import { useState } from "react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { getAuthToken } from "@/lib/api-client";
import { formatRam } from "@/lib/format-bytes";
import { formatSwapCell } from "../process-row-format";
import { cn } from "@/lib/utils";
import type { AppRow as AppRowData } from "./app-rows";

export function appIconUrl(appId: string): string {
  const token = getAuthToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `/api/system/app-icon/${encodeURIComponent(appId)}${query}`;
}

function cpuColor(pct: number): string {
  if (pct > 80) return "text-error";
  if (pct > 50) return "text-warning";
  return "text-text-secondary";
}

export interface AppRowProps {
  app: AppRowData;
  /** True when any of its processes is refused by the server's kill guard. */
  endProtected: boolean;
  onEnd: (app: AppRowData) => void;
}

export function AppRow({ app, endProtected, onEnd }: AppRowProps) {
  const [iconFailed, setIconFailed] = useState(false);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="select-none">
          <div
            className="w-full min-h-11 px-3 py-2 flex items-center gap-3 hover:bg-surface-hover transition-colors"
            data-testid="sysmon-app-row"
            data-app-id={app.id}
            data-cpu={app.cpu}
          >
            {app.icon && !iconFailed ? (
              <img
                src={appIconUrl(app.id)}
                alt=""
                width={24}
                height={24}
                className="size-6 shrink-0 object-contain"
                onError={() => setIconFailed(true)}
              />
            ) : (
              <span
                aria-hidden
                className="size-6 shrink-0 rounded bg-surface-hover grid place-items-center text-[11px] text-text-subtle"
              >
                {app.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="flex-1 min-w-0">
              <span className="block text-sm truncate">{app.name}</span>
              <span className="block text-[11px] text-text-subtle">
                {app.processCount} process{app.processCount === 1 ? "" : "es"}
              </span>
            </span>
            <span className={cn("w-14 text-right text-xs tabular-nums", cpuColor(app.cpu))}>
              {app.cpu.toFixed(1)}%
            </span>
            <span className="w-16 text-right text-xs tabular-nums text-text-secondary">
              {formatRam(app.ramMB)}
            </span>
            {/* Swap only once the host has measured it for somebody: on a machine
                with no per-process source the column would be a wall of dashes. */}
            {app.swapMB !== undefined && (
              <span className="hidden @xs:block w-16 text-right text-xs tabular-nums text-text-subtle">
                {formatSwapCell(app.swapMB)}
              </span>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          variant="destructive"
          disabled={endProtected}
          onSelect={() => { if (!endProtected) onEnd(app); }}
        >
          End application
        </ContextMenuItem>
        {endProtected && (
          <>
            <ContextMenuSeparator />
            <p className="px-2 py-1.5 text-[11px] text-text-subtle max-w-64">
              One of this app's processes is protected, so PPM will not end it.
            </p>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
