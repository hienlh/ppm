import { useMemo, useRef, useEffect } from "react";
import { marked } from "marked";
import { useTabStore } from "@/stores/tab-store";

// Configure marked globally
marked.use({ gfm: true, breaks: true });

interface MarkdownRendererProps {
  content: string;
  /** Project name for file link handling and terminal commands */
  projectName?: string;
  /** Additional CSS classes */
  className?: string;
  /** Show copy/run buttons on code blocks (default: false) */
  codeActions?: boolean;
}

/**
 * Shared markdown renderer with:
 * - Table horizontal scroll on overflow
 * - External links open in new browser tab
 * - File path auto-detection → open in PPM editor
 * - Optional code block copy/run buttons
 */
export function MarkdownRenderer({ content, projectName, className = "", codeActions = false }: MarkdownRendererProps) {
  const html = useMemo(() => {
    try {
      return marked.parse(content) as string;
    } catch {
      return content;
    }
  }, [content]);

  const containerRef = useRef<HTMLDivElement>(null);
  const openTab = useTabStore((s) => s.openTab);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // --- Wrap tables for horizontal scroll ---
    container.querySelectorAll("table").forEach((table) => {
      if (table.parentElement?.classList.contains("table-scroll-wrapper")) return;
      const wrapper = document.createElement("div");
      wrapper.className = "table-scroll-wrapper overflow-x-auto";
      table.parentNode!.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });

    // --- External links → new tab; file paths → open in editor ---
    container.querySelectorAll("a").forEach((link) => {
      const href = link.getAttribute("href") ?? "";

      // External URL → open in new browser tab
      if (/^https?:\/\//.test(href)) {
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
        return;
      }

      // File path detection → open in PPM editor
      const isFilePath = /^(\/|\.\/|\.\.\/)/.test(href)
        || /\.(ts|tsx|js|jsx|py|json|md|yaml|yml|toml|css|html|sh|go|rs|sql|rb|java|kt|swift|c|cpp|h|hpp)$/i.test(href);
      if (isFilePath) {
        link.setAttribute("data-file-path", href);
      }
    });

    // --- Click handler for file links ---
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest("a[data-file-path]") as HTMLAnchorElement | null;
      if (!link || !container.contains(link)) return;

      const filePath = link.getAttribute("data-file-path") ?? "";
      if (!filePath) return;

      e.preventDefault();

      // Absolute path → use /api/fs/read (external file)
      const isAbsolute = /^(\/|[A-Za-z]:[/\\])/.test(filePath);
      const meta: Record<string, unknown> = { filePath };
      if (projectName) meta.projectName = projectName;

      openTab({
        type: "editor",
        title: filePath.split("/").pop() ?? filePath,
        metadata: meta,
        projectId: isAbsolute ? null : (projectName ?? null),
        closable: true,
      });
    };

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

        // Copy button
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

        // Run in terminal (bash only)
        if (isBash && projectName) {
          const runBtn = document.createElement("button");
          runBtn.className = "flex items-center justify-center size-6 rounded bg-surface-elevated/80 hover:bg-surface-elevated text-text-secondary hover:text-text-primary transition-colors border border-border/50";
          runBtn.title = "Run in terminal";
          runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
          runBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(text.replace(/^\$\s*/gm, ""));
            openTab({
              type: "terminal",
              title: "Terminal",
              metadata: { projectName },
              projectId: projectName,
              closable: true,
            });
          });
          actions.appendChild(runBtn);
        }

        pre.appendChild(actions);
      });
    }

    return () => {
      container.removeEventListener("click", handleClick);
    };
  }, [html, projectName, openTab, codeActions]);

  return (
    <div
      ref={containerRef}
      className={`markdown-content prose-sm ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
