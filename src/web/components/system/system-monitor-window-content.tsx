/** Floating-window body for the System Monitor. Persists the active sub-tab on the
 *  window's payload so a reload restores it. */
import { useWindowStore } from "@/components/floating-window/window-store";
import type { WindowContentProps } from "@/components/floating-window/window-content-registry";
import { SystemMonitorBody, parseSysMonTab } from "./system-monitor-body";

export default function SystemMonitorWindowContent({ id, payload }: WindowContentProps) {
  const setPayload = useWindowStore((s) => s.setPayload);

  return (
    <SystemMonitorBody
      initialTab={parseSysMonTab(payload?.tab)}
      onTabChange={(tab) => setPayload(id, { tab })}
      variant="window"
    />
  );
}
