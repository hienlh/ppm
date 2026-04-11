import { useMemo, useRef, useEffect } from "react";
import { marked } from "marked";
import markedKatex from "marked-katex-extension";
import { useTabStore } from "@/stores/tab-store";
import { useFileStore, type FileNode } from "@/stores/file-store";
import { useImageOverlay } from "@/stores/image-overlay-store";
import { useDiagramOverlay } from "@/stores/diagram-overlay-store";
import { openCommandPalette } from "@/hooks/use-global-keybindings";
import { api, projectUrl, getAuthToken } from "@/lib/api-client";
import { basename } from "@/lib/utils";
import mermaid from "mermaid";

/** Mermaid keywords that start a diagram definition */
const MERMAID_KEYWORDS = /^(sequenceDiagram|flowchart|graph\s|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|sankey|xychart|block-beta|packet-beta|architecture-beta|kanban)\b/;

let mermaidInitialized = false;
function ensureMermaidInit() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "default",
    securityLevel: "loose",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  });
  mermaidInitialized = true;
}

/** Detect local absolute file paths (Unix or Windows) */
const LOCAL_PATH_RE = /^(\/|[A-Za-z]:[/\\])/;

// Configure marked globally
marked.use({ gfm: true, breaks: true });
marked.use(markedKatex({ throwOnError: false }));

/** Common text file extensions that PPM can open as editor tabs */
const FILE_EXTS = "ts|tsx|js|jsx|mjs|cjs|py|json|md|mdx|yaml|yml|toml|css|scss|less|html|htm|sh|bash|zsh|go|rs|sql|rb|java|kt|swift|c|cpp|h|hpp|cs|vue|svelte|txt|env|cfg|conf|ini|xml|csv|log|dockerfile|makefile|gradle";
const FILE_EXT_RE = new RegExp(`\\.(${FILE_EXTS})$`, "i");
/** Glob/regex chars that indicate a pattern, not a real file */
const GLOB_CHARS_RE = /[*?{}\[\]]/;

interface MarkdownRendererProps {
  content: string;
  projectName?: string;
  className?: string;
  codeActions?: boolean;
  isStreaming?: boolean;
}

/**
 * Transform HTML string:
 * - Wrap tables in scrollable container
 * - Add target=_blank to external links
 * - Mark <a> file paths with data-file-path
 * - Make inline <code> with file names clickable (via HTML transform, not DOM)
 */
function transformHtml(raw: string): string {
  let html = raw;

  // Wrap <table> in scroll container
  html = html.replace(/<table/g, '<div class="table-scroll-wrapper overflow-x-auto"><table');
  html = html.replace(/<\/table>/g, "</table></div>");

  // External links → target=_blank
  html = html.replace(
    /<a\s+href="(https?:\/\/[^"]+)"/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer"',
  );

  // <a> with file paths → add data-file-path (only files, not folders or glob patterns)
  html = html.replace(/<a\s+href="([^"]+)"/g, (match, href: string) => {
    if (/^https?:\/\//.test(href)) return match; // already handled
    if (GLOB_CHARS_RE.test(href)) return match; // skip glob/regex patterns
    if (!FILE_EXT_RE.test(href)) return match; // must have a file extension
    return `<a href="${href}" data-file-path="${href}"`;
  });

  // Inline <code> with file-like names → make clickable
  // Split by <pre>...</pre> blocks to avoid transforming code inside them
  const parts = html.split(/(<pre[\s\S]*?<\/pre>)/g);
  html = parts.map((part) => {
    // Skip <pre> blocks
    if (part.startsWith("<pre")) return part;
    // Transform inline <code> in non-pre content
    return part.replace(
      /<code>([^<]+)<\/code>/g,
      (match, text: string) => {
        const trimmed = text.trim();
        if (!trimmed || trimmed.includes(" ")) return match;
        if (GLOB_CHARS_RE.test(trimmed)) return match; // skip glob/regex patterns
        if (!FILE_EXT_RE.test(trimmed)) return match; // must have a file extension
        return `<code data-file-clickable="${trimmed}" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted">${text}</code>`;
      },
    );
  }).join("");

  return html;
}

export function MarkdownRenderer({ content, projectName, className = "", codeActions = false, isStreaming = false }: MarkdownRendererProps) {
  const html = useMemo(() => {
    try {
      const raw = marked.parse(content) as string;
      return transformHtml(raw);
    } catch {
      return content;
    }
  }, [content]);

  const containerRef = useRef<HTMLDivElement>(null);
  const openTab = useTabStore((s) => s.openTab);
  const fileTree = useFileStore((s) => s.tree);
  const openImageOverlay = useImageOverlay((s) => s.open);
  const openDiagramOverlay = useDiagramOverlay((s) => s.open);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // --- Render mermaid diagrams ---
    const renderMermaid = async () => {
      ensureMermaidInit();
      const pres = container.querySelectorAll("pre");
      for (const pre of pres) {
        const code = pre.querySelector("code");
        if (!code) continue;
        const langClass = code.className ?? "";
        const text = (code.textContent ?? "").trim();
        const isMermaid = langClass.includes("language-mermaid") || MERMAID_KEYWORDS.test(text);
        if (!isMermaid) continue;

        try {
          const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
          const { svg } = await mermaid.render(id, text);
          const wrapper = document.createElement("div");
          wrapper.className = "mermaid-diagram group relative cursor-pointer rounded-lg border border-border bg-white dark:bg-zinc-50 p-3 overflow-x-auto my-2";
          wrapper.innerHTML = svg;
          // Expand icon hint
          const hint = document.createElement("div");
          hint.className = "absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded bg-black/60 text-white text-xs can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity pointer-events-none";
          hint.textContent = "Click to expand";
          wrapper.appendChild(hint);
          // Click to open overlay
          wrapper.addEventListener("click", () => openDiagramOverlay(svg));
          pre.replaceWith(wrapper);
        } catch {
          // Render failed — leave as code block
        }
      }
    };
    renderMermaid();

    // --- Click handler for file links and clickable code ---
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Check <a data-file-path>
      const link = target.closest("a[data-file-path]") as HTMLAnchorElement | null;
      if (link && container.contains(link)) {
        e.preventDefault();
        openFileOrSearch(link.getAttribute("data-file-path") ?? "");
        return;
      }

      // Check clickable <code>
      const code = target.closest("code[data-file-clickable]") as HTMLElement | null;
      if (code && container.contains(code)) {
        openFileOrSearch(code.getAttribute("data-file-clickable") ?? "");
        return;
      }
    };

    /** Search file tree for matches by filename */
    function findInTree(nodes: FileNode[], name: string): string[] {
      const results: string[] = [];
      for (const node of nodes) {
        if (node.type === "file" && node.name === name) results.push(node.path);
        if (node.children) results.push(...findInTree(node.children, name));
      }
      return results;
    }

    function openFileOrSearch(filePath: string) {
      if (!filePath) return;
      const isAbsolute = /^(\/|[A-Za-z]:[/\\])/.test(filePath);
      const isRelative = /^(\.\/|\.\.\/)/.test(filePath);
      const fileName = basename(filePath);

      // Absolute path → verify then open
      if (isAbsolute) {
        const meta: Record<string, unknown> = { filePath };
        if (projectName) meta.projectName = projectName;
        api.get(`/api/fs/read?path=${encodeURIComponent(filePath)}`).then(() => {
          openTab({ type: "editor", title: fileName, metadata: meta, projectId: null, closable: true });
        }).catch(() => openCommandPalette(filePath));
        return;
      }

      // Relative path with ./ or ../ → try exact path in project
      if (isRelative && projectName) {
        const meta: Record<string, unknown> = { filePath, projectName };
        api.get(`${projectUrl(projectName)}/files/read?path=${encodeURIComponent(filePath)}`)
          .then(() => {
            openTab({ type: "editor", title: fileName, metadata: meta, projectId: projectName, closable: true });
          })
          .catch(() => searchAndOpen(filePath));
        return;
      }

      // Just a filename → search in project tree
      searchAndOpen(filePath);
    }

    /** Search project file tree; if 1 match → open directly, else → command palette with full path */
    function searchAndOpen(filePath: string) {
      const fileName = basename(filePath);
      const matches = findInTree(fileTree, fileName);
      if (matches.length === 1) {
        const match = matches[0]!;
        openTab({
          type: "editor",
          title: fileName,
          metadata: { filePath: match, projectName },
          projectId: projectName ?? null,
          closable: true,
        });
      } else {
        openCommandPalette(filePath);
      }
    }

    container.addEventListener("click", handleClick);

    // --- Auth-load images with local file paths ---
    const blobUrls: string[] = [];
    container.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      // Only intercept local file paths, not http/data/blob URLs
      if (!LOCAL_PATH_RE.test(src)) return;
      // Mark as loading
      img.style.opacity = "0.3";
      img.style.minHeight = "48px";
      img.style.minWidth = "48px";
      const token = getAuthToken();
      fetch(`/api/fs/raw?path=${encodeURIComponent(src)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then((r) => {
          if (!r.ok) throw new Error("Failed to load");
          return r.blob();
        })
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          blobUrls.push(url);
          img.src = url;
          img.style.opacity = "";
          img.style.minHeight = "";
          img.style.minWidth = "";
          // Style: constrain size, add border like AuthImage
          img.style.maxHeight = "400px";
          img.style.maxWidth = "100%";
          img.style.objectFit = "contain";
          img.style.borderRadius = "0.375rem";
          img.style.border = "1px solid var(--color-border)";
          img.style.cursor = "pointer";
          img.onclick = () => openImageOverlay(url, img.alt || basename(src));
        })
        .catch(() => {
          img.style.opacity = "0.5";
          img.alt = `[Image not found: ${basename(src)}]`;
        });
    });

    // --- Code block copy/run buttons ---
    if (codeActions) {
      container.querySelectorAll("pre").forEach((pre) => {
        if (pre.querySelector(".code-actions")) return;
        const code = pre.querySelector("code");
        const text = code?.textContent ?? pre.textContent ?? "";
        const langClass = code?.className ?? "";
        const isBash = /language-(bash|sh|shell|zsh)/.test(langClass)
          || (!langClass.includes("language-") && text.startsWith("$"));

        pre.style.position = "relative";
        pre.classList.add("group");

        const actions = document.createElement("div");
        actions.className = "code-actions absolute top-1 right-1 flex gap-1";

        const copyBtn = document.createElement("button");
        copyBtn.className = "flex items-center justify-center size-6 rounded bg-surface-elevated/80 hover:bg-surface-elevated text-text-secondary hover:text-text-primary transition-colors border border-border/50";
        copyBtn.title = "Copy";
        copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
        copyBtn.addEventListener("click", () => {
          navigator.clipboard.writeText(text);
          copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
          setTimeout(() => {
            copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
          }, 2000);
        });
        actions.appendChild(copyBtn);

        if (isBash && projectName) {
          const runBtn = document.createElement("button");
          runBtn.className = "flex items-center justify-center size-6 rounded bg-surface-elevated/80 hover:bg-surface-elevated text-text-secondary hover:text-text-primary transition-colors border border-border/50";
          runBtn.title = "Run in terminal";
          runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
          runBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(text.replace(/^\$\s*/gm, ""));
            openTab({ type: "terminal", title: "Terminal", metadata: { projectName }, projectId: projectName, closable: true });
          });
          actions.appendChild(runBtn);
        }

        pre.appendChild(actions);
      });
    }

    return () => {
      container.removeEventListener("click", handleClick);
      blobUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [html, projectName, openTab, codeActions, openImageOverlay, openDiagramOverlay]);

  return (
    <div
      ref={containerRef}
      className={`markdown-content prose-sm ${isStreaming ? "is-streaming" : ""} ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
