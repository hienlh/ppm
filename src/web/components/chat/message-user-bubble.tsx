/**
 * The user's half of the transcript.
 *
 * A user message is not just text: it carries the attachments the composer sent,
 * the system tags the SDK injected (`<task-notification>`, `<environment_details>`)
 * which are *not* things the user typed and must not read as if they were, and
 * absolute file paths worth turning into something clickable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, ExternalLink, FileText,
  Pencil, RotateCcw, Slash, Tag, TerminalSquare, XCircle,
} from "@/lib/icons";
import { cn, basename } from "@/lib/utils";
import { MessageActionBar, ActionButton } from "./message-action-bar";
import { VersionSwitcher } from "./version-switcher";
import { parseUserMessage, type SystemTag } from "./user-message-parse";
import type { VersionGroup } from "../../../types/api";
import { useTabStore } from "@/stores/tab-store";
import { useProjectStore } from "@/stores/project-store";
import { api } from "@/lib/api-client";
import { MarkdownContent } from "./message-markdown";
import { AuthImageThumbnail, isImagePath } from "./message-media";

/** Detect if tags contain system-injected content (not real user input) */
const SYSTEM_TAG_NAMES = new Set(["task-notification", "environment_details", "local-command-caveat"]);

/** User message bubble — full width, collapsible, with system tag badges */
export function UserBubble({ content, messageId, timestamp, projectName, onFork, onEdit, isEditing, sessionId, providerId, versionGroup, onNavigateVersion, versionNavDisabled }: {
  content: string;
  messageId?: string;
  timestamp: string;
  projectName?: string;
  onFork?: () => void;
  onEdit?: () => void;
  isEditing?: boolean;
  sessionId?: string;
  providerId?: string;
  versionGroup?: VersionGroup;
  onNavigateVersion?: (sessionId: string) => void;
  versionNavDisabled?: boolean;
}) {
  const { files, text, tags, command, terminalBlocks, idePath, agent } = useMemo(
    () => parseUserMessage(content),
    [content],
  );

  const isSystemContext = tags.some((t) => SYSTEM_TAG_NAMES.has(t.name));

  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const check = () => setIsOverflowing(el.scrollHeight > el.clientHeight + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  return (
    <div className={cn("flex flex-col gap-1", !isSystemContext && "items-end")}>
    {/* Own-content bubble: accent-wash fill + custom radius (sharp bottom-right
        corner anchors it to the sender on the right). */}
    <div
      data-user-message={!isSystemContext ? "true" : undefined}
      style={!isSystemContext ? { borderRadius: "var(--rad) var(--rad) 4px var(--rad)" } : undefined}
      className={cn(
        "group/user relative px-3 py-2 text-sm border shadow-sm transition-all",
      isSystemContext
        ? "rounded-lg bg-surface/40 border-border/40 text-text-secondary"
        : "max-w-[80%] bg-accent-wash border-accent-wash-border text-text",
      isEditing && "ring-2 ring-primary/60 border-primary/40",
    )}>
      {/* System tags as badges */}
      {tags.length > 0 && <SystemTagBadges tags={tags} />}

      {/* Agent delegation chip — parsed back from the "Use the X agent to" prefix */}
      {agent && (
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="inline-flex items-center gap-1 rounded-md bg-sky-500/15 border border-sky-500/25 px-2 py-0.5 text-xs font-medium text-sky-600 dark:text-sky-400">
            <Bot className="size-3 shrink-0" />
            {agent}
          </span>
        </div>
      )}

      {/* Slash command chip — args rendered in body for expand/collapse support */}
      {command && (
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="inline-flex items-center gap-1 rounded-md bg-primary/15 border border-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
            <Slash className="size-3 shrink-0" />
            {command.name}
          </span>
        </div>
      )}

      {/* IDE context — the file the user had open, as a clickable chip */}
      {idePath && (
        <div className="flex items-center gap-1.5 mb-1 text-[11px] text-text-subtle">
          <span className="shrink-0">Opened in IDE:</span>
          <FilePathChip path={idePath} projectName={projectName} />
        </div>
      )}

      {/* Attached files — image thumbnails + file chips */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((filePath, i) =>
            isImagePath(filePath) ? (
              <AuthImageThumbnail key={i} filePath={filePath} projectName={projectName} />
            ) : (
              <div
                key={i}
                className="flex items-center gap-1 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-[11px] text-text-secondary"
              >
                <FileText className="size-3 shrink-0" />
                <span className="truncate max-w-32">{basename(filePath)}</span>
              </div>
            ),
          )}
        </div>
      )}

      {/* Terminal output previews */}
      {terminalBlocks.length > 0 && (
        <div className="space-y-1.5">
          {terminalBlocks.map((block, i) => (
            <TerminalBlockPreview key={i} content={block} />
          ))}
        </div>
      )}

      {/* Text content — 2-line clamp by default, expandable */}
      {text && (
        <div
          ref={contentRef}
          className={cn(
            "whitespace-pre-wrap break-words transition-all duration-200 select-text",
            !expanded && "line-clamp-2",
            expanded && "max-h-[50vh] overflow-y-auto",
          )}
        >
          {isSystemContext ? <TextWithFilePaths text={text} projectName={projectName} /> : <TextWithLinks text={text} />}
        </div>
      )}
      {(isOverflowing || expanded) && (
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            "flex items-center gap-1 text-xs mt-1 transition-colors",
            isSystemContext ? "text-text-subtle hover:text-text-secondary" : "text-primary/70 hover:text-primary",
          )}
        >
          {expanded ? <><ChevronUp className="size-3" />Show less</> : <><ChevronDown className="size-3" />Show more</>}
        </button>
      )}
      {/* Version switcher — only when this message has edited siblings */}
      {!isSystemContext && onNavigateVersion && (
        <VersionSwitcher
          group={versionGroup}
          onNavigate={onNavigateVersion}
          disabled={versionNavDisabled}
        />
      )}
    </div>
      {/* Action bar below the bubble — timestamp, copy, edit/fork (real user messages only) */}
      {!isSystemContext && (
        <MessageActionBar timestamp={timestamp} content={content}>
          {onEdit && (
            <ActionButton
              icon={<Pencil className="size-3.5" />}
              label="Edit"
              title="Edit this message (continue in the same tab)"
              onClick={onEdit}
            />
          )}
          {onFork && (
            <ActionButton
              icon={<RotateCcw className="size-3.5" />}
              label="Fork"
              title="Retry from this message (fork into a new tab)"
              onClick={onFork}
            />
          )}
        </MessageActionBar>
      )}
    </div>
  );
}

/** Collapsible terminal output preview in user messages */
function TerminalBlockPreview({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
          expanded
            ? "border-primary/50 bg-surface-elevated text-text-primary"
            : "border-border/60 bg-background/40 text-text-secondary hover:bg-surface",
        )}
      >
        <TerminalSquare className="size-3.5 shrink-0" />
        <span>Terminal output</span>
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-background p-2 text-xs text-text-primary font-mono whitespace-pre-wrap break-words">
          {content}
        </pre>
      )}
    </div>
  );
}

/** Render system tags as collapsible badges */
function SystemTagBadges({ tags }: { tags: SystemTag[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag, i) => (
        <SystemTagBadge key={i} tag={tag} />
      ))}
    </div>
  );
}

function SystemTagBadge({ tag }: { tag: SystemTag }) {
  const [open, setOpen] = useState(false);

  // Task notification: render formatted instead of raw XML
  if (tag.name === "task-notification") {
    return <TaskNotificationBadge content={tag.content} />;
  }

  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-full border border-border/60 bg-surface/50 px-2 py-0.5 text-text-subtle hover:text-text-secondary hover:bg-surface transition-colors"
      >
        <Tag className="size-2.5" />
        <span>{tag.label}</span>
        <ChevronRight className={cn("size-2.5 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-1 rounded border border-border/40 bg-surface/30 px-2 py-1.5 text-[11px] text-text-subtle/80 whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed">
          {tag.content}
        </div>
      )}
    </div>
  );
}

/** Extract a sub-tag value from XML-like content */
function xmlTag(content: string, tag: string): string | undefined {
  const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m?.[1]?.trim() || undefined;
}

/** Formatted badge for <task-notification> — shows status, summary, output file, result */
function TaskNotificationBadge({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const status = xmlTag(content, "status");
  const summary = xmlTag(content, "summary");
  const outputFile = xmlTag(content, "output-file");
  const result = xmlTag(content, "result");
  const isOk = status === "completed";

  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-full border border-border/60 bg-surface/50 px-2 py-0.5 text-text-subtle hover:text-text-secondary hover:bg-surface transition-colors"
      >
        {isOk ? <CheckCircle2 className="size-2.5 text-success" /> : <XCircle className="size-2.5 text-warning" />}
        <span className="truncate max-w-80">{summary ?? "Task notification"}</span>
        <ChevronRight className={cn("size-2.5 transition-transform shrink-0", open && "rotate-90")} />
      </button>
      {open && (
        <div className="mt-1 rounded border border-border/40 bg-surface/30 px-2 py-1.5 space-y-1.5">
          {/* Full summary (button truncates it) */}
          {summary && <p className="text-[11px] text-text-secondary">{summary}</p>}
          {outputFile && <FilePathChip path={outputFile} />}
          {result && (
            <div className="text-[11px] text-text-subtle/80 max-h-60 overflow-y-auto leading-relaxed">
              <MarkdownContent content={result} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Clickable file path chip — opens file in editor tab */
function FilePathChip({ path, projectName }: { path: string; projectName?: string }) {
  const handleClick = useCallback(() => {
    const openTab = useTabStore.getState().openTab;
    const pName = projectName ?? useProjectStore.getState().activeProject?.name;
    const fileName = basename(path);
    const meta: Record<string, unknown> = { filePath: path };
    if (pName) meta.projectName = pName;
    // Try to verify file exists, then open; fallback: open directly
    api.get(`/api/fs/read?path=${encodeURIComponent(path)}`).then(() => {
      openTab({ type: "editor", title: fileName, metadata: meta, projectId: null, closable: true });
    }).catch(() => {
      openTab({ type: "editor", title: fileName, metadata: meta, projectId: null, closable: true });
    });
  }, [path, projectName]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1 rounded border border-border/50 bg-surface/50 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary hover:text-text-primary hover:bg-surface transition-colors cursor-pointer"
    >
      <FileText className="size-2.5 shrink-0" />
      <span className="truncate max-w-60">{basename(path)}</span>
      <ExternalLink className="size-2 shrink-0 opacity-50" />
    </button>
  );
}

/** Render plain text with http(s) URLs turned into clickable links. Preserves
 *  whitespace/newlines via the surrounding `whitespace-pre-wrap` container. */
function TextWithLinks({ text }: { text: string }) {
  const parts = useMemo(() => {
    const re = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
    const result: { kind: "text" | "url"; value: string }[] = [];
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) result.push({ kind: "text", value: text.slice(last, m.index) });
      result.push({ kind: "url", value: m[1]! });
      last = m.index + m[0].length;
    }
    if (last < text.length) result.push({ kind: "text", value: text.slice(last) });
    return result;
  }, [text]);

  // No URLs — return the raw string so nothing about the layout changes.
  if (parts.every((p) => p.kind === "text")) return <>{text}</>;

  return (
    <>
      {parts.map((p, i) =>
        p.kind === "url" ? (
          <a
            key={i}
            href={p.value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80 break-all"
            onClick={(e) => e.stopPropagation()}
          >
            {p.value}
          </a>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </>
  );
}

/** Render text with absolute file paths detected and turned into clickable chips */
function TextWithFilePaths({ text, projectName }: { text: string; projectName?: string }) {
  const parts = useMemo(() => {
    // Match absolute file paths (at least 2 segments)
    const re = /(\/(?:[\w.\-]+\/)+[\w.\-]+)/g;
    const result: { kind: "text" | "path"; value: string }[] = [];
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) result.push({ kind: "text", value: text.slice(last, m.index) });
      result.push({ kind: "path", value: m[1]! });
      last = m.index + m[0].length;
    }
    if (last < text.length) result.push({ kind: "text", value: text.slice(last) });
    return result;
  }, [text]);

  return (
    <>
      {parts.map((p, i) =>
        p.kind === "path"
          ? <FilePathChip key={i} path={p.value} projectName={projectName} />
          : <span key={i}>{p.value}</span>,
      )}
    </>
  );
}