import { useMemo, useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import { useImageOverlay } from "@/stores/image-overlay-store";
import { collectGallery, GALLERY_ITEM_ATTR } from "@/lib/image-gallery";
import { useDiagramOverlay } from "@/stores/diagram-overlay-store";
import { getAuthToken } from "@/lib/api-client";
import { basename } from "@/lib/utils";
import { MdContext, useMdContext, LOCAL_PATH_RE, markdownUrlTransform, parseMarkdownFileTarget } from "./markdown-context";
import { useMarkdownFileNavigation } from "./use-markdown-file-navigation";
import { MdPre, MdCode } from "./markdown-code-block";

interface MarkdownRendererProps {
  content: string;
  projectName?: string;
  className?: string;
  codeActions?: boolean;
  isStreaming?: boolean;
}

/** Plugin arrays — stable references to avoid re-creating on each render */
const remarkPlugins = [[remarkGfm, { singleTilde: false }], [remarkMath, { singleDollarTextMath: false }], remarkBreaks] as any;
const rehypePlugins = [rehypeRaw, rehypeKatex] as any;
/** Component map — stable references; dynamic state flows through MdContext */
const mdComponents = { a: MdLink, img: MdImage, pre: MdPre, code: MdCode, table: MdTable };

export function MarkdownRenderer({ content, projectName, className = "", codeActions = false, isStreaming = false }: MarkdownRendererProps) {
  const openImageOverlayFn = useImageOverlay((s) => s.open);
  const openDiagramOverlayFn = useDiagramOverlay((s) => s.open);
  const openFileOrSearch = useMarkdownFileNavigation(projectName);

  const ctx = useMemo(() => ({
    projectName, codeActions, isStreaming, openFileOrSearch,
    openImageOverlay: openImageOverlayFn,
    openDiagramOverlay: openDiagramOverlayFn,
  }), [projectName, codeActions, isStreaming, openFileOrSearch, openImageOverlayFn, openDiagramOverlayFn]);

  return (
    <MdContext.Provider value={ctx}>
      <div className={`markdown-content prose-sm ${isStreaming ? "is-streaming" : ""} ${className}`}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          urlTransform={markdownUrlTransform}
          components={mdComponents}
        >
          {content}
        </ReactMarkdown>
      </div>
    </MdContext.Provider>
  );
}

/** Link — external links open in new tab; file paths open in editor */
function MdLink({ href, children, node, ...props }: any) {
  const { openFileOrSearch } = useMdContext();
  if (href?.match(/^(https?:)?\/\//i)) {
    return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
  }
  const target = href ? parseMarkdownFileTarget(href) : null;
  if (target) {
    return <a href={href} onClick={(e: React.MouseEvent) => { e.preventDefault(); openFileOrSearch(target.path, target.line); }} {...props}>{children}</a>;
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
      {...{ [GALLERY_ITEM_ATTR]: "" }}
      onClick={(e) => displaySrc && openImageOverlay(displaySrc, name, collectGallery(e.currentTarget))}
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
