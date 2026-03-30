import { useMemo, useRef, useEffect } from "react";
import { ChevronRight, Folder, File, FileCode, FileJson, FileText, FileType } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFileStore, type FileNode } from "@/stores/file-store";
import { useTabStore } from "@/stores/tab-store";
import { basename } from "@/lib/utils";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  ts: FileCode, tsx: FileCode, js: FileCode, jsx: FileCode,
  py: FileCode, rs: FileCode, go: FileCode, html: FileCode,
  css: FileCode, scss: FileCode,
  json: FileJson,
  md: FileText, txt: FileText,
  yaml: FileType, yml: FileType,
};

function getIcon(name: string, isDir: boolean) {
  if (isDir) return Folder;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ICON_MAP[ext] ?? File;
}

interface BreadcrumbSegment {
  name: string;
  fullPath: string;
  node: FileNode | null;
  siblings: FileNode[];
}

function walkTree(tree: FileNode[], segments: string[]): BreadcrumbSegment[] {
  const result: BreadcrumbSegment[] = [];
  let current: FileNode[] = tree;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const fullPath = segments.slice(0, i + 1).join("/");
    const match = current.find((n) => n.name === seg);
    result.push({
      name: seg,
      fullPath,
      node: match ?? null,
      siblings: current,
    });
    if (match?.children) {
      current = match.children;
    } else {
      // Remaining segments have no tree data — add as plain
      for (let j = i + 1; j < segments.length; j++) {
        result.push({
          name: segments[j]!,
          fullPath: segments.slice(0, j + 1).join("/"),
          node: null,
          siblings: [],
        });
      }
      break;
    }
  }
  return result;
}

function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

interface EditorBreadcrumbProps {
  filePath: string;
  projectName: string;
  tabId: string;
  className?: string;
}

export function EditorBreadcrumb({ filePath, projectName, tabId, className }: EditorBreadcrumbProps) {
  const tree = useFileStore((s) => s.tree);
  const { updateTab, openTab } = useTabStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  const segments = useMemo(
    () => walkTree(tree, filePath.split("/").filter(Boolean)),
    [tree, filePath],
  );

  // Auto-scroll to rightmost segment
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [segments]);

  function handleFileClick(path: string, e: React.MouseEvent) {
    const name = basename(path);
    if (e.metaKey || e.ctrlKey) {
      openTab({ type: "editor", title: name, metadata: { filePath: path, projectName }, projectId: projectName, closable: true });
    } else {
      updateTab(tabId, { title: name, metadata: { filePath: path, projectName } });
    }
  }

  return (
    <div ref={scrollRef} className={className}>
      {segments.map((seg, i) => (
        <div key={seg.fullPath} className="flex items-center shrink-0">
          {i > 0 && <ChevronRight className="size-3 text-muted-foreground shrink-0 mx-0.5" />}
          {seg.siblings.length > 0 ? (
            <SegmentDropdown
              segment={seg}
              isLast={i === segments.length - 1}
              projectName={projectName}
              onFileClick={handleFileClick}
            />
          ) : (
            <span className="text-xs text-muted-foreground px-1 py-0.5">{seg.name}</span>
          )}
        </div>
      ))}
    </div>
  );
}

interface SegmentDropdownProps {
  segment: BreadcrumbSegment;
  isLast: boolean;
  projectName: string;
  onFileClick: (path: string, e: React.MouseEvent) => void;
}

function SegmentDropdown({ segment, isLast, projectName, onFileClick }: SegmentDropdownProps) {
  const sorted = useMemo(() => sortNodes(segment.siblings), [segment.siblings]);

  return (
    <DropdownMenu>
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
      <DropdownMenuContent align="start" className="max-h-[300px] overflow-hidden p-0">
        <ScrollArea className="max-h-[300px]">
          <div className="p-1">
            {sorted.map((node) => (
              <NodeMenuItem
                key={node.path}
                node={node}
                projectName={projectName}
                activePath={segment.fullPath}
                onFileClick={onFileClick}
              />
            ))}
          </div>
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface NodeMenuItemProps {
  node: FileNode;
  projectName: string;
  activePath: string;
  onFileClick: (path: string, e: React.MouseEvent) => void;
}

function NodeMenuItem({ node, projectName, activePath, onFileClick }: NodeMenuItemProps) {
  const Icon = getIcon(node.name, node.type === "directory");
  const isActive = node.path === activePath;

  if (node.type === "directory" && node.children && node.children.length > 0) {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className={`text-xs gap-1.5 ${isActive ? "bg-muted" : ""}`}>
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-[300px] overflow-hidden p-0">
          <ScrollArea className="max-h-[300px]">
            <div className="p-1">
              {sortNodes(node.children).map((child) => (
                <NodeMenuItem
                  key={child.path}
                  node={child}
                  projectName={projectName}
                  activePath={activePath}
                  onFileClick={onFileClick}
                />
              ))}
            </div>
          </ScrollArea>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  return (
    <DropdownMenuItem
      className={`text-xs gap-1.5 cursor-pointer ${isActive ? "bg-muted" : ""}`}
      onSelect={(e) => {
        // onSelect doesn't give MouseEvent, use click handler for Ctrl detection
      }}
      onClick={(e) => {
        if (node.type === "directory") return;
        onFileClick(node.path, e);
      }}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{node.name}</span>
    </DropdownMenuItem>
  );
}
