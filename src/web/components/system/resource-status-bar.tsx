import { memo } from "react";
import { Cpu } from "lucide-react";
import { useResourceMonitor } from "@/hooks/use-resource-monitor";
import { useTabStore } from "@/stores/tab-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";

function cpuColor(cpu: number) {
  if (cpu > 80) return "text-red-500";
  if (cpu > 50) return "text-yellow-500";
  return "text-green-500";
}

export const ResourceStatusBar = memo(function ResourceStatusBar() {
  const { latest, isConnected } = useResourceMonitor();
  const openTab = useTabStore((s) => s.openTab);
  const isMobile = useIsMobile();

  const handleClick = () => {
    openTab({
      type: "system-monitor",
      title: "System Monitor",
      projectId: null,
      closable: true,
    });
  };

  if (!isConnected || !latest) {
    return (
      <button
        onClick={handleClick}
        className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-text-subtle hover:text-text-secondary transition-colors w-full"
      >
        <Cpu className="size-3 opacity-50" />
        <span className="opacity-50">Connecting...</span>
      </button>
    );
  }

  const { cpu, ramMB, processCount } = latest.total;

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-1.5 px-2 py-1 text-[10px] hover:bg-surface-hover transition-colors w-full cursor-pointer"
      title="Open System Monitor"
    >
      <Cpu className={cn("size-3", cpuColor(cpu))} />
      <span className={cpuColor(cpu)}>
        {isMobile ? `${cpu.toFixed(0)}%` : `CPU ${cpu.toFixed(1)}%`}
      </span>
      <span className="text-text-subtle">|</span>
      <span className="text-text-secondary">
        {ramMB < 1024
          ? `${ramMB.toFixed(0)}MB`
          : `${(ramMB / 1024).toFixed(1)}GB`}
      </span>
      {!isMobile && (
        <>
          <span className="text-text-subtle">|</span>
          <span className="text-text-subtle">{processCount} proc</span>
        </>
      )}
    </button>
  );
});
