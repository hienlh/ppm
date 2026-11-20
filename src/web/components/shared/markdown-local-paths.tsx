/**
 * Folder and file paths in rendered Markdown (an AI answer, a card, a report) as links: a folder
 * opens the file browser there; a text or code file of the chat's project opens in the editor, as
 * an explicit file link does; any other file opens the file browser with the file selected.
 *
 * Nothing is a link until the server has said the path exists and may be shown
 * (`POST /api/fs/locate`, under the same rules as the Assistant's `ui_open_file_browser`): a path
 * that is missing, PPM's own folder or a store of logins and keys stays plain text. The check
 * waits for the message to finish streaming and is batched and cached (`file-browser-locate.ts`),
 * so a finished answer costs one request however many paths it names. A tap checks again.
 *
 * Paths in running text are found by `rehypeLocalPathLinks`, which runs after the sanitiser and
 * only splits text nodes, so it adds no markup the sanitiser did not see the like of; paths in an
 * inline code span are found by `MdCode` (`inlineCodePath`).
 */

import { useEffect, type ReactNode } from "react";
import { useProjectStore } from "@/stores/project-store";
import { relativeProjectPath } from "@/stores/file-store";
import { openExplorer } from "@/components/os-explorer/open-explorer";
import { findPathsInText } from "@/lib/local-path-detect";
import { openFileBrowserAt, requestVerdict, useVerdict } from "@/lib/file-browser-locate";
import type { SourceLine } from "@/lib/source-location";
import { isAssistantProject } from "../../../shared/assistant-project";
import type { FileBrowserLocateEntry } from "../../../shared/file-browser-target";
import { FILE_EXT_RE, useMdContext } from "./markdown-context";

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

/** The hast property marking a link this plugin made; React sees it as `data-ppm-local-path`. */
export const LOCAL_PATH_PROP = "dataPpmLocalPath";
const LINE_PROP = "dataPpmLocalLine";

/** Text inside these is already a link, code, or not prose. */
const SKIP_TAGS = new Set(["a", "code", "pre", "kbd", "samp", "script", "style", "svg", "math", "button", "textarea"]);

/** KaTeX's own markup: `a/b` in a formula is a fraction, never a path. */
function isMath(node: HastNode): boolean {
  const className = node.properties?.className;
  const classes = Array.isArray(className) ? className : typeof className === "string" ? className.split(/\s+/) : [];
  return classes.some((c) => typeof c === "string" && (c === "katex" || c === "katex-display" || c.startsWith("math")));
}

function splitText(node: HastNode): HastNode[] | null {
  const text = node.value ?? "";
  const found = findPathsInText(text);
  if (found.length === 0) return null;
  const out: HastNode[] = [];
  let at = 0;
  for (const hit of found) {
    if (hit.start > at) out.push({ type: "text", value: text.slice(at, hit.start) });
    out.push({
      type: "element",
      tagName: "a",
      properties: {
        href: hit.path,
        [LOCAL_PATH_PROP]: hit.path,
        ...(hit.line ? { [LINE_PROP]: hit.line.end ? `${hit.line.start}-${hit.line.end}` : String(hit.line.start) } : {}),
      },
      children: [{ type: "text", value: text.slice(hit.start, hit.end) }],
    });
    at = hit.end;
  }
  if (at < text.length) out.push({ type: "text", value: text.slice(at) });
  return out;
}

function walk(node: HastNode): void {
  if (!node.children) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      next.push(...(splitText(child) ?? [child]));
      continue;
    }
    if (child.type === "element" && (SKIP_TAGS.has(child.tagName ?? "") || isMath(child))) {
      next.push(child);
      continue;
    }
    walk(child);
    next.push(child);
  }
  node.children = next;
}

/** Rehype plugin: wraps every path in running text in a marked `<a>` for `LocalPathLink`. */
export function rehypeLocalPathLinks() {
  return (tree: HastNode) => walk(tree);
}

/** The line a marked link carries (`12` or `12-20`). */
export function lineFromProp(value: unknown): SourceLine | undefined {
  if (typeof value !== "string") return undefined;
  const m = value.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return undefined;
  return { start: Number(m[1]), ...(m[2] ? { end: Number(m[2]) } : {}) };
}

/** Whether a checked file opens in the editor: a text or code file of the chat's project. */
function opensInEditor(entry: Extract<FileBrowserLocateEntry, { ok: true }>, projectRoot: string | undefined): boolean {
  if (entry.kind !== "file" || !entry.select || !projectRoot) return false;
  return relativeProjectPath(projectRoot, entry.select) !== null && FILE_EXT_RE.test(entry.select);
}

/**
 * The check behind a path: asked once the message has finished, read from the shared cache.
 * `project` is the chat's project (relative paths resolve against it), never the Assistant's.
 */
function useCheckedPath(path: string): { entry: FileBrowserLocateEntry | undefined; project: string | undefined } {
  const { projectName, isStreaming } = useMdContext();
  const project = projectName && !isAssistantProject(projectName) ? projectName : undefined;
  useEffect(() => {
    if (!isStreaming) requestVerdict(path, project);
  }, [path, project, isStreaming]);
  return { entry: useVerdict(path, project), project };
}

function useOpenChecked(path: string, line: SourceLine | undefined) {
  const { openFileOrSearch } = useMdContext();
  return async (entry: Extract<FileBrowserLocateEntry, { ok: true }>, project: string | undefined) => {
    const root = project ? useProjectStore.getState().projects.find((p) => p.name === project)?.path : undefined;
    if (opensInEditor(entry, root)) {
      openFileOrSearch(entry.select!, line);
      return;
    }
    // The file browser: checked again now, since the disk may have changed since the link was drawn.
    if (entry.kind === "folder") await openFileBrowserAt(entry.dir);
    else if (entry.select) await openFileBrowserAt(entry.select);
    else await openExplorer(entry.dir);
  };
}

/** A path found in running text: a link once checked, its text until then (and for good if refused). */
export function LocalPathLink({ path, line, children }: { path: string; line?: SourceLine; children: ReactNode }) {
  const { entry, project } = useCheckedPath(path);
  const open = useOpenChecked(path, line);
  if (!entry || !entry.ok) return <>{children}</>;
  return (
    <a
      href={path}
      data-local-path={entry.kind}
      title={entry.kind === "folder" ? `Open ${entry.dir} in the file browser` : entry.select ?? path}
      onClick={(e) => { e.preventDefault(); void open(entry, project); }}
    >
      {children}
    </a>
  );
}

/** An inline code span quoting a path: clickable once checked, plain code otherwise. */
export function LocalPathCode({ path, line, children, ...rest }: { path: string; line?: SourceLine; children: ReactNode } & Record<string, unknown>) {
  const { entry, project } = useCheckedPath(path);
  const open = useOpenChecked(path, line);
  if (!entry || !entry.ok) return <code {...rest}>{children}</code>;
  return (
    <code
      role="link"
      tabIndex={0}
      data-local-path={entry.kind}
      title={entry.kind === "folder" ? `Open ${entry.dir} in the file browser` : entry.select ?? path}
      onClick={() => void open(entry, project)}
      onKeyDown={(e) => { if (e.key === "Enter") void open(entry, project); }}
      style={{ cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" }}
      {...rest}
    >
      {children}
    </code>
  );
}
