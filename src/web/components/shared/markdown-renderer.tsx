import { useMemo, useCallback, useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { useTabStore } from "@/stores/tab-store";
import { useFileStore, type FileNode } from "@/stores/file-store";
import { useImageOverlay } from "@/stores/image-overlay-store";
import { useDiagramOverlay } from "@/stores/diagram-overlay-store";
import { openCommandPalette } from "@/hooks/use-global-keybindings";
import { api, projectUrl, getAuthToken } from "@/lib/api-client";
import { basename } from "@/lib/utils";
import { MdContext, useMdContext, FILE_EXT_RE, GLOB_CHARS_RE, LOCAL_PATH_RE } from "./markdown-context";
import { MdPre, MdCode } from "./markdown-code-block";

interface MarkdownRendererProps {
  content: string;
  projectName?: string;
  className?: string;
  codeActions?: boolean;
  isStreaming?: boolean;
}

/** Plugin arrays — stable references to avoid re-creating on each render */
const remarkPlugins = [remarkGfm, remarkMath, remarkBreaks] as any;
const rehypePlugins = [rehypeRaw, rehypeKatex, rehypeHighlight] as any;

/** Component map — stable references; dynamic state flows through MdContext */
const mdComponents = { a: MdLink, img: MdImage, pre: MdPre, code: MdCode, table: MdTable };

function findInTree(nodes: FileNode[], name: string): string[] {
  const results: string[] = [];
  for (const n of nodes) {
    if (n.type === "file" && n.name === name) results.push(n.path);
    if (n.children) results.push(...findInTree(n.children, name));
  }
  return results;
}

export function MarkdownRenderer({ content, projectName, className = "", codeActions = false, isStreaming = false }: MarkdownRendererProps) {
  const openTab = useTabStore((s) => s.openTab);
  const fileTree = useFileStore((s) => s.tree);
  const openImageOverlayFn = useImageOverlay((s) => s.open);
  const openDiagramOverlayFn = useDiagramOverlay((s) => s.open);

  const openFileOrSearch = useCallback((filePath: string) => {
    if (!filePath) return;
    const isAbsolute = /^(\/|[A-Za-z]:[/\\])/.test(filePath);
    const isRelative = /^(\.\/|\.\.\/)/.test(filePath);
    const fileName = basename(filePath);

    const searchAndOpen = (fp: string) => {
      const matches = findInTree(fileTree, basename(fp));
      if (matches.length === 1) {
        openTab({ type: "editor", title: basename(fp), metadata: { filePath: matches[0], projectName }, projectId: projectName ?? null, closable: true });
      } else {
        openCommandPalette(fp);
      }
    };

    if (isAbsolute) {
      const meta: Record<string, unknown> = { filePath };
      if (projectName) meta.projectName = projectName;
      api.get(`/api/fs/read?path=${encodeURIComponent(filePath)}`).then(() => {
        openTab({ type: "editor", title: fileName, metadata: meta, projectId: null, closable: true });
      }).catch(() => openCommandPalette(filePath));
      return;
    }

    if (isRelative && projectName) {
      api.get(`${projectUrl(projectName)}/files/read?path=${encodeURIComponent(filePath)}`)
        .then(() => openTab({ type: "editor", title: fileName, metadata: { filePath, projectName }, projectId: projectName, closable: true }))
        .catch(() => searchAndOpen(filePath));
      return;
    }

    searchAndOpen(filePath);
  }, [openTab, fileTree, projectName]);

  const ctx = useMemo(() => ({
    projectName, codeActions, openFileOrSearch,
    openImageOverlay: openImageOverlayFn,
    openDiagramOverlay: openDiagramOverlayFn,
  }), [projectName, codeActions, openFileOrSearch, openImageOverlayFn, openDiagramOverlayFn]);

  return (
    <MdContext.Provider value={ctx}>
      <div className={`markdown-content prose-sm ${isStreaming ? "is-streaming" : ""} ${className}`}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents}>
          {content}
        </ReactMarkdown>
      </div>
    </MdContext.Provider>
  );
}

/** Link — external links open in new tab; file paths open in editor */
function MdLink({ href, children, node, ...props }: any) {
  const { openFileOrSearch } = useMdContext();
  if (href?.match(/^https?:\/\//)) {
    return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
  }
  if (href && !GLOB_CHARS_RE.test(href) && FILE_EXT_RE.test(href)) {
    return <a href={href} onClick={(e: React.MouseEvent) => { e.preventDefault(); openFileOrSearch(href); }} {...props}>{children}</a>;
  }
  return <a href={href} {...props}>{children}</a>;
}

/** Image — auth-loads local file paths via API, click to open overlay */
function MdImage({ src, alt, node, ...props }: any) {
  const { openImageOverlay } = useMdContext();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!src || !LOCAL_PATH_RE.test(src)) return;
    setLoading(true);
    let cancelled = false;
    let url: string | null = null;
    const token = getAuthToken();
    fetch(`/api/fs/raw?path=${encodeURIComponent(src)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => { if (!r.ok) throw new Error(); return r.blob(); })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [src]);

  const displaySrc = blobUrl || src || "";
  const name = alt || (src ? basename(src) : "");

  return (
    <img
      src={displaySrc}
      alt={name}
      onClick={() => displaySrc && openImageOverlay(displaySrc, name)}
      className="max-h-[400px] max-w-full object-contain rounded-md border border-border cursor-pointer"
      style={{ opacity: loading ? 0.3 : 1, minHeight: loading ? 48 : undefined, minWidth: loading ? 48 : undefined }}
      {...props}
    />
  );
}

/** Table — wrap in scrollable container */
function MdTable({ children, node, ...props }: any) {
  return <div className="table-scroll-wrapper overflow-x-auto"><table {...props}>{children}</table></div>;
}
