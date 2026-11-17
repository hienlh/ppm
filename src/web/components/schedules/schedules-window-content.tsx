/** Floating-window body for Schedules (desktop). */
import type { WindowContentProps } from "@/components/floating-window/window-content-registry";
import { SchedulesApp } from "./schedules-app";

export default function SchedulesWindowContent(_props: WindowContentProps) {
  return <SchedulesApp mode="window" />;
}
