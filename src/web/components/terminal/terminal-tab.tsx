import { useRef } from "react";
import { Plus } from "lucide-react";
import { Button } from "../ui/button";
import { useTerminal } from "../../hooks/use-terminal";
import { useTabStore } from "../../stores/tab.store";
import "@xterm/xterm/css/xterm.css";

interface TerminalTabProps {
  terminalId: string;
}

export function TerminalTab({ terminalId }: TerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { openTab } = useTabStore();

  useTerminal({ terminalId, containerRef });

  const handleNewTerminal = () => {
    openTab({
      type: "terminal",
      title: "Terminal",
      closable: true,
    });
  };

  return (
    <div className="flex flex-col h-full bg-[#1e1e2e]">
      <div className="flex items-center justify-between px-2 py-1 border-b border-border/40 shrink-0">
        <span className="text-xs text-muted-foreground font-mono">terminal</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={handleNewTerminal}
          title="New Terminal"
        >
          <Plus className="size-3" />
        </Button>
      </div>
      <div ref={containerRef} className="flex-1 overflow-hidden p-1" />
    </div>
  );
}
