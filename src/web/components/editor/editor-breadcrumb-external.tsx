import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { ChevronRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api-client";
import { basename } from "@/lib/utils";
import { useTabStore } from "@/stores/tab-store";
import { useShallow } from "zustand/react/shallow";
import { getIcon } from "./editor-breadcrumb";

interface BrowseEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}

interface BrowseResult {
  entries: BrowseEntry[];
}

interface ExternalSegment {
  name: string;
  /** Absolute path of this segment */
  absPath: string;
  /** Directory whose entries are this segment's siblings */
  parentDir: string;
}

/** Split an absolute path into breadcrumb segments with their parent dir.
 *  Handles both POSIX (/a/b) and Windows (C:\a\b) separators. */
function buildSegments(filePath: string): ExternalSegment[] {
  const isPosixAbs = filePath.startsWith("/");
  const parts = filePath.split(/[/\\]/).filter(Boolean);
  const abs = (i: number) => {
    const p = (isPosixAbs ? "/" : "") + parts.slice(0, i + 1).join("/");
    // A bare drive letter ("C:") resolves to the drive's cwd, not its root — add slash
    return /^[A-Za-z]:$/.test(p) ? p + "/" : p;
  };
  const root = isPosixAbs ? "/" : (parts[0] ?? "") + "/";
  return parts.map((name, i) => ({
    name,
    absPath: abs(i),
    parentDir: i > 0 ? abs(i - 1) : root,
  }));
}

async function browseDir(dirPath: string): Promise<BrowseEntry[]> {
  const result = await api.get<BrowseResult>(
    `/api/fs/browse?path=${encodeURIComponent(dirPath)}`,
  );
  return result.entries;
}

interface EditorBreadcrumbExternalProps {
  filePath: string;
  projectName: string;
  tabId: string;
  className?: string;
}

export function EditorBreadcrumbExternal({
  filePath,
  projectName,
  tabId,
  className,
}: EditorBreadcrumbExternalProps) {
  const { updateTab, openTab } = useTabStore(
    useShallow((s) => ({ updateTab: s.updateTab, openTab: s.openTab })),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const segments = useMemo(() => buildSegments(filePath), [filePath]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [segments]);

  const handleFileClick = useCallback(
    (path: string, e: React.MouseEvent) => {
      const name = basename(path);
      const metadata = { filePath: path, projectName };
      if (e.metaKey || e.ctrlKey) {
        openTab({ type: "editor", title: name, metadata, projectId: projectName, closable: true });
      } else {
        updateTab(tabId, { title: name, metadata });
      }
    },
    [projectName, tabId, openTab, updateTab],
  );

  return (
    <div ref={scrollRef} className={className}>
      {segments.map((seg, i) => (
        <div key={seg.absPath} className="flex items-center shrink-0">
          {i > 0 && <ChevronRight className="size-3 text-muted-foreground shrink-0 mx-0.5" />}
          <ExternalSegmentDropdown
            segment={seg}
            isLast={i === segments.length - 1}
            onFileClick={handleFileClick}
          />
        </div>
      ))}
    </div>
  );
}

interface ExternalSegmentDropdownProps {
  segment: ExternalSegment;
  isLast: boolean;
  onFileClick: (path: string, e: React.MouseEvent) => void;
}

function ExternalSegmentDropdown({ segment, isLast, onFileClick }: ExternalSegmentDropdownProps) {
  const [entries, setEntries] = useState<BrowseEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(open: boolean) {
    if (open && entries === null) {
      browseDir(segment.parentDir)
        .then(setEntries)
        .catch((e) => {
          setError((e as Error).message || "Failed to browse");
          setEntries([]);
        });
    }
  }

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`text-xs px-1 py-0.5 rounded hover:bg-muted transition-colors truncate max-w-[120px] ${
            isLast ? "text-foreground font-medium" : "text-muted-foreground"
          }`}
        >
          {segment.name}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[300px] overflow-y-auto p-1">
        {entries === null ? (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            Loading…
          </DropdownMenuItem>
        ) : error ? (
          <DropdownMenuItem disabled className="text-xs text-destructive">
            {error}
          </DropdownMenuItem>
        ) : entries.length === 0 ? (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            Empty
          </DropdownMenuItem>
        ) : (
          entries.map((entry) => (
            <ExternalNodeMenuItem
              key={entry.path}
              entry={entry}
              activePath={segment.absPath}
              onFileClick={onFileClick}
            />
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ExternalNodeMenuItemProps {
  entry: BrowseEntry;
  activePath: string;
  onFileClick: (path: string, e: React.MouseEvent) => void;
}

function ExternalNodeMenuItem({ entry, activePath, onFileClick }: ExternalNodeMenuItemProps) {
  const Icon = getIcon(entry.name, entry.type === "directory");
  const isActive = entry.path === activePath;
  const [children, setChildren] = useState<BrowseEntry[] | null>(null);

  if (entry.type === "directory") {
    function handleSubOpen(open: boolean) {
      if (open && children === null) {
        browseDir(entry.path)
          .then(setChildren)
          .catch(() => setChildren([]));
      }
    }

    return (
      <DropdownMenuSub onOpenChange={handleSubOpen}>
        <DropdownMenuSubTrigger className={`text-xs gap-1.5 ${isActive ? "bg-muted" : ""}`}>
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{entry.name}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-[300px] overflow-y-auto p-1">
          {children === null ? (
            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
              Loading…
            </DropdownMenuItem>
          ) : children.length === 0 ? (
            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
              Empty
            </DropdownMenuItem>
          ) : (
            children.map((child) => (
              <ExternalNodeMenuItem
                key={child.path}
                entry={child}
                activePath={activePath}
                onFileClick={onFileClick}
              />
            ))
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  return (
    <DropdownMenuItem
      className={`text-xs gap-1.5 cursor-pointer ${isActive ? "bg-muted" : ""}`}
      onClick={(e) => onFileClick(entry.path, e)}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{entry.name}</span>
    </DropdownMenuItem>
  );
}
