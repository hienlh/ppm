/**
 * Floating-window body for Logs. The open sub-tab rides on the window's payload, so a reload
 * comes back to it; the payload is untrusted (it survives in localStorage), hence the parse.
 */
import { useWindowStore } from "@/components/floating-window/window-store";
import type { WindowContentProps } from "@/components/floating-window/window-content-registry";
import { LogsApp } from "./logs-app";
import { parseLogsView } from "./open-logs";

export default function LogsWindowContent({ id, payload }: WindowContentProps) {
  const setPayload = useWindowStore((s) => s.setPayload);
  return <LogsApp mode="window" initialView={parseLogsView(payload?.view)} onViewChange={(view) => setPayload(id, { view })} />;
}
