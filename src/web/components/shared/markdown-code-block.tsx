import { useState, useEffect, useRef, type ReactNode } from "react";
import mermaid from "mermaid";
import { useMdContext, FILE_EXT_RE, GLOB_CHARS_RE } from "./markdown-context";
import { useTabStore } from "@/stores/tab-store";

const MERMAID_KEYWORDS = /^(sequenceDiagram|flowchart|graph\s|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|sankey|xychart|block-beta|packet-beta|architecture-beta|kanban)\b/;

let mermaidInitialized = false;
function ensureMermaidInit() {
  if (mermaidInitialized) return;
  mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose", fontFamily: "ui-sans-serif, system-ui, sans-serif" });
  mermaidInitialized = true;
}

/** Extract plain text from a hast node tree */
function hastToText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  if (node.children) return node.children.map(hastToText).join("");
  return "";
}

/** Pre — code block wrapper with mermaid detection and action buttons */
export function MdPre({ children, node, ...rest }: any) {
  const { codeActions, projectName, openDiagramOverlay } = useMdContext();
  const openTab = useTabStore((s) => s.openTab);

  const codeNode = node?.children?.[0];
  const langClass = (codeNode?.properties?.className ?? []).find((c: string) => c.startsWith("language-"));
  const lang = langClass?.replace("language-", "");
  const text = hastToText(codeNode);

  // Mermaid detection
  if (lang === "mermaid" || (!lang && MERMAID_KEYWORDS.test(text.trim()))) {
    return <MermaidDiagram source={text.trim()} />;
  }

  const isBash = /^(bash|sh|shell|zsh)$/.test(lang || "") || (!lang && text.startsWith("$"));

  return (
    <pre {...rest} className={`relative group ${rest.className || ""}`}>
      {children}
      {codeActions && (
        <div className="code-actions absolute top-1 right-1 flex gap-1">
          <ActionBtn title="Copy" icon={<CopyIcon />} activeIcon={<CheckIcon />} onClick={() => navigator.clipboard.writeText(text)} />
          {isBash && projectName && (
            <ActionBtn
              title="Run in terminal"
              icon={<PlayIcon />}
              onClick={() => {
                navigator.clipboard.writeText(text.replace(/^\$\s*/gm, ""));
                openTab({ type: "terminal", title: "Terminal", metadata: { projectName }, projectId: projectName, closable: true });
              }}
            />
          )}
        </div>
      )}
    </pre>
  );
}

/** Code — inline code with file clicking; block code passes through */
export function MdCode({ className, children, node, ...rest }: any) {
  const { openFileOrSearch } = useMdContext();

  // Block code (has language/hljs class from rehype-highlight) — render as-is
  if (className) return <code className={className} {...rest}>{children}</code>;

  // Inline code — check for clickable file paths
  const text = String(children ?? "").trim();
  if (text && !text.includes(" ") && !GLOB_CHARS_RE.test(text) && FILE_EXT_RE.test(text)) {
    return (
      <code
        onClick={() => openFileOrSearch(text)}
        style={{ cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" as const }}
        {...rest}
      >
        {children}
      </code>
    );
  }

  return <code {...rest}>{children}</code>;
}

/** Mermaid diagram renderer with click-to-expand */
function MermaidDiagram({ source }: { source: string }) {
  const { openDiagramOverlay } = useMdContext();
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    ensureMermaidInit();
    const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
    mermaid.render(id, source).then(({ svg }) => setSvg(svg)).catch(() => {});
  }, [source]);

  if (!svg) return <pre><code>{source}</code></pre>;

  return (
    <div
      className="mermaid-diagram group relative cursor-pointer rounded-lg border border-border bg-white dark:bg-zinc-50 p-3 overflow-x-auto my-2"
      onClick={() => openDiagramOverlay(svg)}
    >
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded bg-black/60 text-white text-xs can-hover:opacity-0 can-hover:group-hover:opacity-100 transition-opacity pointer-events-none">
        Click to expand
      </div>
    </div>
  );
}

/** Reusable code-block action button with optional active state */
function ActionBtn({ title, icon, activeIcon, onClick }: { title: string; icon: ReactNode; activeIcon?: ReactNode; onClick: () => void }) {
  const [active, setActive] = useState(false);
  return (
    <button
      className="flex items-center justify-center size-6 rounded bg-surface-elevated/80 hover:bg-surface-elevated text-text-secondary hover:text-text-primary transition-colors border border-border/50"
      title={title}
      onClick={() => { onClick(); if (activeIcon) { setActive(true); setTimeout(() => setActive(false), 2000); } }}
    >
      {active && activeIcon ? activeIcon : icon}
    </button>
  );
}

const CopyIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
);

const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const PlayIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);
