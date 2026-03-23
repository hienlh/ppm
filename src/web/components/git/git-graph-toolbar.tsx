import { useState, useRef, useEffect } from "react";
import {
  RefreshCw,
  Download,
  Search,
  Settings,
  X,
  ChevronDown,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { GitBranch } from "../../../types/git";

interface GitGraphToolbarProps {
  branches: GitBranch[];
  branchFilter: string;
  onBranchFilterChange: (value: string) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  showSearch: boolean;
  onToggleSearch: () => void;
  onFetch: () => void;
  onRefresh: () => void;
  onOpenSettings?: () => void;
  loading: boolean;
  acting: boolean;
  projectName?: string;
}

export function GitGraphToolbar({
  branches,
  branchFilter,
  onBranchFilterChange,
  searchQuery,
  onSearchQueryChange,
  showSearch,
  onToggleSearch,
  onFetch,
  onRefresh,
  onOpenSettings,
  loading,
  acting,
  projectName,
}: GitGraphToolbarProps) {
  const localBranches = branches.filter((b) => !b.remote);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [branchSearch, setBranchSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setBranchSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  const filteredBranches = branchSearch
    ? localBranches.filter((b) =>
        b.name.toLowerCase().includes(branchSearch.toLowerCase()),
      )
    : localBranches;

  const selectedLabel =
    branchFilter === "__all__"
      ? "Show All"
      : localBranches.find((b) => b.name === branchFilter)?.name ?? "Show All";

  return (
    <div className="border-b bg-background">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        {/* Repo (single for now) */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
          <span className="font-semibold">Repo:</span>
          <span className="font-medium text-foreground truncate max-w-[120px]">
            {projectName ?? "—"}
          </span>
        </div>

        <div className="w-px h-4 bg-border mx-1" />

        {/* Branch filter — custom searchable dropdown */}
        <div className="relative shrink-0" ref={dropdownRef}>
          <button
            type="button"
            className="flex items-center gap-1 h-6 px-2 text-xs border rounded-md bg-transparent hover:bg-muted/50"
            onClick={() => { setDropdownOpen((o) => !o); setBranchSearch(""); }}
          >
            <span className="font-semibold text-muted-foreground">Branches:</span>
            <span className="max-w-[100px] truncate">{selectedLabel}</span>
            <ChevronDown className="size-3 opacity-50" />
          </button>
          {dropdownOpen && (
            <div className="absolute top-full left-0 mt-1 z-50 w-[220px] rounded-md border bg-popover shadow-md">
              <div className="p-1.5">
                <Input
                  className="h-6 text-xs px-2"
                  placeholder="Filter branches..."
                  value={branchSearch}
                  onChange={(e) => setBranchSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="max-h-[200px] overflow-y-auto p-1">
                <BranchDropdownItem
                  label="Show All"
                  selected={branchFilter === "__all__"}
                  onClick={() => { onBranchFilterChange("__all__"); setDropdownOpen(false); }}
                />
                {filteredBranches.map((b) => (
                  <BranchDropdownItem
                    key={b.name}
                    label={b.name}
                    current={b.current}
                    selected={branchFilter === b.name}
                    onClick={() => { onBranchFilterChange(b.name); setDropdownOpen(false); }}
                  />
                ))}
                {filteredBranches.length === 0 && branchSearch && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">No branches found</div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* Search input (toggled) */}
        {showSearch && (
          <div className="flex items-center gap-1">
            <Input
              className="h-6 text-xs w-[160px] px-2"
              placeholder="Search commits..."
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              autoFocus
            />
            <Button variant="ghost" size="icon-xs" onClick={onToggleSearch}>
              <X className="size-3" />
            </Button>
          </div>
        )}

        {/* Action buttons */}
        {!showSearch && (
          <Button variant="ghost" size="icon-xs" onClick={onToggleSearch} title="Find">
            <Search className="size-3.5" />
          </Button>
        )}
        <Button variant="ghost" size="icon-xs" onClick={onOpenSettings} title="Settings">
          <Settings className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onFetch} disabled={acting} title="Fetch">
          <Download className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onRefresh} disabled={acting} title="Refresh">
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
    </div>
  );
}

function BranchDropdownItem({
  label,
  selected,
  current,
  onClick,
}: {
  label: string;
  selected: boolean;
  current?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-2 w-full px-2 py-1 text-xs rounded-sm hover:bg-accent hover:text-accent-foreground text-left"
      onClick={onClick}
    >
      <Check className={`size-3 shrink-0 ${selected ? "opacity-100" : "opacity-0"}`} />
      <span className="truncate flex-1">{label}</span>
      {current && (
        <span className="text-[10px] text-muted-foreground italic">current</span>
      )}
    </button>
  );
}
