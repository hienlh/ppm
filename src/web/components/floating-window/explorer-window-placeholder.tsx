/**
 * Stand-in body for an explorer window until the real explorer is wired into the registry.
 *
 * It deliberately contains an iframe and a long scrollable list: both are the content types
 * that swallow pointer events, so dragging the window while they are visible exercises the
 * layer's capture overlay.
 */

import type { WindowContentProps } from "./window-content-registry";

export default function ExplorerWindowPlaceholder({ id, payload }: WindowContentProps) {
  const path = typeof payload?.path === "string" ? payload.path : "(no path)";
  return (
    <div className="h-full flex flex-col text-xs text-text-2">
      <div className="px-3 py-2 border-b border-border bg-panel-2 font-mono truncate">{path}</div>
      <div className="flex-1 min-h-0 grid grid-cols-2 gap-px bg-border">
        <ul className="overflow-auto bg-panel p-2 space-y-1">
          {Array.from({ length: 40 }, (_, i) => (
            <li key={i} className="px-2 py-1 rounded-sm can-hover:hover:bg-surface-elevated">
              item-{i.toString().padStart(2, "0")}
            </li>
          ))}
        </ul>
        <iframe
          title={`window-${id}-preview`}
          className="w-full h-full bg-panel"
          srcDoc="<body style='margin:0;font:12px system-ui;color:#888;padding:12px'>embedded frame</body>"
        />
      </div>
    </div>
  );
}
