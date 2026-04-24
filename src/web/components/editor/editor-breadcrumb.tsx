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
import { useFileStore, type FileNode } from "@/stores/file-store";
import { useShallow } from "zustand/react/shallow";
import { useTabStore } from "@/stores/tab-store";
import { useProjectStore } from "@/stores/project-store";
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
  /** Folder path whose children are the siblings (empty string = root) */
  parentPath: string;
}

function walkTree(tree: FileNode[], segments: string[]): BreadcrumbSegment[] {
  const result: BreadcrumbSegment[] = [];
  let current: FileNode[] = tree;
  let parentPath = "";

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const fullPath = segments.slice(0, i + 1).join("/");
    const match = current.find((n) => n.name === seg);
    result.push({
      name: seg,
      fullPath,
      node: match ?? null,
      siblings: current,
      parentPath,
    });
    if (match?.children) {
      parentPath = match.path;
      current = match.children;
    } else {
      // Remaining segments — parent children not loaded yet
      for (let j = i + 1; j < segments.length; j++) {
        result.push({
          name: segments[j]!,
          fullPath: segments.slice(0, j + 1).join("/"),
          node: null,
          siblings: [],
          parentPath: segments.slice(0, j).join("/"),
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
  const { updateTab, openTab } = useTabStore(useShallow((s) => ({ updateTab: s.updateTab, openTab: s.openTab })));
  const projectPath = useProjectStore((s) => s.projects.find((p) => p.name === projectName)?.path ?? "");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Strip project root prefix so segments align with the relative-path file tree
  const { prefixParts, relativePath } = useMemo(() => {
    const norm = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    const normRoot = projectPath.startsWith("/") ? projectPath.slice(1) : projectPath;
    if (normRoot && norm.startsWith(normRoot + "/")) {
      const rel = norm.slice(normRoot.length + 1);
      return { prefixParts: normRoot.split("/"), relativePath: rel };
    }
    return { prefixParts: [] as string[], relativePath: norm };
  }, [filePath, projectPath]);

  const segments = useMemo(
    () => walkTree(tree, relativePath.split("/").filter(Boolean)),
    [tree, relativePath],
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
      {prefixParts.map((part, i) => (
        <div key={`prefix-${i}`} className="flex items-center shrink-0">
          {i > 0 && <ChevronRight className="size-3 text-muted-foreground shrink-0 mx-0.5" />}
          <span className="text-xs text-muted-foreground px-1 py-0.5">{part}</span>
        </div>
      ))}
      {segments.map((seg, i) => (
        <div key={seg.fullPath} className="flex items-center shrink-0">
          {(i > 0 || prefixParts.length > 0) && <ChevronRight className="size-3 text-muted-foreground shrink-0 mx-0.5" />}
          <SegmentDropdown
            segment={seg}
            isLast={i === segments.length - 1}
            projectName={projectName}
            onFileClick={handleFileClick}
          />
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
  const loadChildren = useFileStore((s) => s.loadChildren);
  const loadedPaths = useFileStore((s) => s.loadedPaths);
  const sorted = useMemo(() => sortNodes(segment.siblings), [segment.siblings]);
  const isLoaded = loadedPaths.has(segment.parentPath);

  function handleOpenChange(open: boolean) {
    if (open && !isLoaded) {
      loadChildren(projectName, segment.parentPath);
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
      <DropdownMenuContent align="start" className="max-h-[300px] p-1">
        {sorted.length === 0 ? (
          <DropdownMenuItem disabled className="text-xs text-muted-foreground">
            Loading…
          </DropdownMenuItem>
        ) : (
          sorted.map((node) => (
            <NodeMenuItem
              key={node.path}
              node={node}
              projectName={projectName}
              activePath={segment.fullPath}
              onFileClick={onFileClick}
            />
          ))
        )}
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
  const loadChildren = useFileStore((s) => s.loadChildren);
  const loadedPaths = useFileStore((s) => s.loadedPaths);

  if (node.type === "directory") {
    const children = node.children ?? [];
    const isLoaded = loadedPaths.has(node.path);

    function handleSubOpen(open: boolean) {
      if (open && !isLoaded) {
        loadChildren(projectName, node.path);
      }
    }

    return (
      <DropdownMenuSub onOpenChange={handleSubOpen}>
        <DropdownMenuSubTrigger className={`text-xs gap-1.5 ${isActive ? "bg-muted" : ""}`}>
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-[300px] overflow-y-auto p-1">
          {children.length === 0 ? (
            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
              Loading…
            </DropdownMenuItem>
          ) : (
            sortNodes(children).map((child) => (
              <NodeMenuItem
                key={child.path}
                node={child}
                projectName={projectName}
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
      onSelect={(e) => {
        // onSelect doesn't give MouseEvent, use click handler for Ctrl detection
      }}
      onClick={(e) => {
        onFileClick(node.path, e);
      }}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{node.name}</span>
    </DropdownMenuItem>
  );
}
