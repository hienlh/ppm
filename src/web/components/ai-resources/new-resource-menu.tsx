import { Plus, Hexagon, Bot, SquareTerminal, Plug, Download } from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { AiResourceType } from "@/lib/api-ai-resources";

interface NewResourceMenuProps {
  onCreate: (type: AiResourceType) => void;
  onAddMcp: () => void;
  onImportMcp: () => void;
}

export function NewResourceMenu({ onCreate, onAddMcp, onImportMcp }: NewResourceMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90">
          <Plus className="size-3" /> New
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={() => onCreate("skill")}>
          <Hexagon className="size-3.5" /> New Skill
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onCreate("agent")}>
          <Bot className="size-3.5" /> New Agent
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onCreate("command")}>
          <SquareTerminal className="size-3.5" /> New Command
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onAddMcp}>
          <Plug className="size-3.5" /> New MCP Server
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onImportMcp}>
          <Download className="size-3.5" /> Import MCP…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
