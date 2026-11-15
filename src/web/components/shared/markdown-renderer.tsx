import { useMemo, useState, useEffect, useContext } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import { useImageOverlay } from "@/stores/image-overlay-store";
import { collectGallery, GALLERY_ITEM_ATTR } from "@/lib/image-gallery";
import { useDiagramOverlay } from "@/stores/diagram-overlay-store";
import { getAuthToken } from "@/lib/api-client";
import { basename } from "@/lib/utils";
import { normalizeMathDelimiters } from "@/lib/markdown-math-delimiters";
import { MdContext, useMdContext, AssistantContentContext, LOCAL_PATH_RE, markdownUrlTransform, parseMarkdownFileTarget } from "./markdown-context";
import { useMarkdownFileNavigation } from "./use-markdown-file-navigation";
import { MdPre, MdCode } from "./markdown-code-block";
import { isExternalResourceUrl, rehypeBlockExternalResources } from "./markdown-external-resources";
import { rehypeStampMarkdownElements, rehypeStripAuthorPresentation } from "./markdown-author-presentation";
import { isAssistantProject } from "../../../shared/assistant-project";
import { markdownSanitizeSchema, rehypePrefixFragmentLinks, sanitizedRemarkRehypeOptions } from "./markdown-sanitize";

interface MarkdownRendererProps {
  content: string;
  projectName?: string;
  className?: string;
  codeActions?: boolean;
  isStreaming?: boolean;
  /** Written by the PPM Assistant: see `MdContextValue.assistantContent`. */
  assistantContent?: boolean;
  /**
   * Parse HTML inside the Markdown (default), keeping only what `markdownSanitizeSchema`
   * allows. Off for text nobody in this session wrote, such as a system tag's content, where
   * HTML in the source is shown as text instead.
   */
  rawHtml?: boolean;
  /**
   * A PPM Assistant card's text, written by a manager AI: Markdown only (HTML in it is shown as
   * text), held to the Assistant's rules, no image loaded on its own (a local one included), and
   * links that leave the app in a new tab. Implies `assistantContent` and no `rawHtml`.
   */
  card?: boolean;
}

/** Plugin arrays — stable references to avoid re-creating on each render */
const remarkPlugins = [[remarkGfm, { singleTilde: false }], [remarkMath, { singleDollarTextMath: false }], remarkBreaks] as any;
// Sanitise straight after parsing raw HTML and before KaTeX, so KaTeX's own markup is not
// held to the allow-list.
const rehypePlugins = [rehypeRaw, [rehypeSanitize, markdownSanitizeSchema], rehypePrefixFragmentLinks, rehypeKatex] as any;
const rehypePluginsNoRaw = [rehypeKatex] as any;
/**
 * Assistant content goes through the same allow-list, and more: the author's `class`/`style`
 * are stripped right after `rehype-raw` (the stamp telling Markdown's own elements from the
 * author's is read and removed there, before the sanitiser would drop it), and KaTeX's own
 * layout survives. The external-resource filter runs before the sanitiser, so an embed it turns
 * into a link survives as one rather than being dropped with its target, and again last, so it
 * also sees what KaTeX produced.
 */
const assistantRehypePlugins = [
  rehypeStampMarkdownElements, rehypeRaw, rehypeStripAuthorPresentation, rehypeBlockExternalResources,
  [rehypeSanitize, markdownSanitizeSchema], rehypePrefixFragmentLinks, rehypeKatex, rehypeBlockExternalResources,
] as any;
const assistantRehypePluginsNoRaw = [rehypeKatex, rehypeBlockExternalResources] as any;
/** Component map — stable references; dynamic state flows through MdContext */
const mdComponents = { a: MdLink, img: MdImage, pre: MdPre, code: MdCode, table: MdTable };

export function MarkdownRenderer({ content, projectName, className = "", codeActions = false, isStreaming = false, assistantContent: assistantProp, rawHtml: rawHtmlProp = true, card = false }: MarkdownRendererProps) {
  const inAssistantChat = useContext(AssistantContentContext);
  const assistantContent = Boolean(card || assistantProp || inAssistantChat || isAssistantProject(projectName));
  const rawHtml = rawHtmlProp && !card;
  const openImageOverlayFn = useImageOverlay((s) => s.open);
  const openDiagramOverlayFn = useDiagramOverlay((s) => s.open);
  // The Assistant's virtual project has no files: its links name absolute paths, opened as such.
  const openFileOrSearch = useMarkdownFileNavigation(isAssistantProject(projectName) ? undefined : projectName);
  // Before parsing, because Markdown reads `\[` as an escaped bracket and the backslash is
  // gone by the time there is a tree to walk.
  const source = useMemo(() => normalizeMathDelimiters(content), [content]);

  const ctx = useMemo(() => ({
    projectName, codeActions, isStreaming, assistantContent, card, openFileOrSearch,
    openImageOverlay: openImageOverlayFn,
    openDiagramOverlay: openDiagramOverlayFn,
  }), [projectName, codeActions, isStreaming, assistantContent, card, openFileOrSearch, openImageOverlayFn, openDiagramOverlayFn]);

  return (
    <MdContext.Provider value={ctx}>
      {/* Assistant content is painted inside its own box and nowhere else: `contain: paint`
          clips like `overflow: clip` and also makes the box the containing block for fixed
          and absolute descendants, so nothing in it can cover the page or a card's buttons. */}
      <div className={`markdown-content prose-sm ${assistantContent ? "[contain:paint]" : ""} ${isStreaming ? "is-streaming" : ""} ${className}`}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={assistantContent
            ? (rawHtml ? assistantRehypePlugins : assistantRehypePluginsNoRaw)
            : (rawHtml ? rehypePlugins : rehypePluginsNoRaw)}
          remarkRehypeOptions={rawHtml ? sanitizedRemarkRehypeOptions : undefined}
          urlTransform={markdownUrlTransform}
          components={mdComponents}
        >
          {source}
        </ReactMarkdown>
      </div>
    </MdContext.Provider>
  );
}

/** Link — external links open in new tab; file paths open in editor */
function MdLink({ href, children, node, ...props }: any) {
  const { openFileOrSearch, card } = useMdContext();
  const external = Boolean(href?.match(/^(https?:)?\/\//i));
  const target = !external && href ? parseMarkdownFileTarget(href) : null;
  if (card && !target) return <CardLink href={href} node={node} {...props}>{children}</CardLink>;
  if (external) {
    return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
  }
  if (target) {
    return <a href={href} onClick={(e: React.MouseEvent) => { e.preventDefault(); openFileOrSearch(target.path, target.line); }} {...props}>{children}</a>;
  }
  return <a href={href} {...props}>{children}</a>;
}

/** The text a hast node shows. */
function textOfNode(node: any): string {
  if (!node) return "";
  if (node.type === "text") return String(node.value ?? "");
  return (node.children ?? []).map(textOfNode).join("");
}

/**
 * A link in a card's text, which a manager AI wrote. It never replaces the app it is read in: it
 * opens in a new tab, an in-page anchor stays put, and one whose scheme was refused (blanked by
 * the URL filter) is just its text. A label that does not name where the link goes is followed by
 * the host it does go to, since a phone shows no target on hover.
 */
function CardLink({ href, node, children, ...props }: any) {
  if (!href) return <span {...props}>{children}</span>;
  if (href.startsWith("#")) return <a href={href} {...props}>{children}</a>;
  let host = "";
  try { host = new URL(href, window.location.href).host; } catch { /* not a URL: no host to show */ }
  const shown = host && host !== window.location.host && !textOfNode(node).toLowerCase().includes(host.toLowerCase());
  return (
    <>
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
      {shown && <span className="text-text-subtle" data-link-host=""> ({host})</span>}
    </>
  );
}

/** Image — auth-loads local file paths via API, click to open overlay */
function MdImage({ src, alt, node, ...props }: any) {
  const { openImageOverlay, assistantContent, card } = useMdContext();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // `//host/x` passes LOCAL_PATH_RE, and the plain `src` below is rendered while the local
  // load runs — so in Assistant content an external source must never reach the <img>.
  const blocked = assistantContent && typeof src === "string" && isExternalResourceUrl(src);
  // A card loads no picture at all, not even through PPM's own API: its pictures are `payload.images`.
  const held = card && !blocked;

  useEffect(() => {
    if (blocked || held || !src || !LOCAL_PATH_RE.test(src)) return;
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
  }, [src, blocked, held]);

  const name = alt || (src ? basename(src) : "");
  if (blocked) {
    return <a href={src} target="_blank" rel="noopener noreferrer" title={`Not loaded automatically: ${src}`}>Image: {alt || src}</a>;
  }
  if (held) return <span className="md-blocked-resource" title={`Not loaded automatically: ${src ?? ""}`}>Image: {alt || src}</span>;
  const displaySrc = blobUrl || src || "";

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
