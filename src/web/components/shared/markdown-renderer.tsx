import { useMemo, useRef, useEffect } from "react";
import { marked } from "marked";
import { useTabStore } from "@/stores/tab-store";
import { openCommandPalette } from "@/hooks/use-global-keybindings";
import { api } from "@/lib/api-client";

// Configure marked globally
marked.use({ gfm: true, breaks: true });

/** Common text file extensions that PPM can open as editor tabs */
const FILE_EXTS = "ts|tsx|js|jsx|mjs|cjs|py|json|md|mdx|yaml|yml|toml|css|scss|less|html|htm|sh|bash|zsh|go|rs|sql|rb|java|kt|swift|c|cpp|h|hpp|cs|vue|svelte|txt|env|cfg|conf|ini|xml|csv|log|dockerfile|makefile|gradle";
const FILE_EXT_RE = new RegExp(`\\.(${FILE_EXTS})$`, "i");

interface MarkdownRendererProps {
  content: string;
  projectName?: string;
  className?: string;
  codeActions?: boolean;
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

  // <a> with file paths → add data-file-path
  html = html.replace(/<a\s+href="([^"]+)"/g, (match, href: string) => {
    if (/^https?:\/\//.test(href)) return match; // already handled
    const isFile = /^(\/|\.\/|\.\.\/)/.test(href) || FILE_EXT_RE.test(href);
    return isFile ? `<a href="${href}" data-file-path="${href}"` : match;
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
        if (!FILE_EXT_RE.test(trimmed) && !/^(\/|\.\/|\.\.\/)/.test(trimmed)) return match;
        return `<code data-file-clickable="${trimmed}" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted">${text}</code>`;
      },
    );
  }).join("");

  return html;
}

export function MarkdownRenderer({ content, projectName, className = "", codeActions = false }: MarkdownRendererProps) {
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

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

    function openFileOrSearch(filePath: string) {
      if (!filePath) return;
      const isAbsolute = /^(\/|[A-Za-z]:[/\\])/.test(filePath);
      const meta: Record<string, unknown> = { filePath };
      if (projectName) meta.projectName = projectName;

      if (isAbsolute) {
        // Verify existence, then open or fallback to search
        api.get(`/api/fs/read?path=${encodeURIComponent(filePath)}`).then(() => {
          openTab({ type: "editor", title: filePath.split("/").pop() ?? filePath, metadata: meta, projectId: null, closable: true });
        }).catch(() => openCommandPalette(filePath));
      } else if (projectName) {
        openTab({ type: "editor", title: filePath.split("/").pop() ?? filePath, metadata: meta, projectId: projectName, closable: true });
      } else {
        openCommandPalette(filePath);
      }
    }

    container.addEventListener("click", handleClick);

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

    return () => container.removeEventListener("click", handleClick);
  }, [html, projectName, openTab, codeActions]);

  return (
    <div
      ref={containerRef}
      className={`markdown-content prose-sm ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
