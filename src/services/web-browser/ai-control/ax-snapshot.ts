/**
 * A page as an AI reads it: Chrome's accessibility tree, cut down to what a person would see and
 * act on, one line per node, interactive ones numbered `[ref=eN]` so `browser_click` and
 * `browser_type` can name them. The page's text is untrusted — anyone can write anything into a
 * page — so the whole snapshot goes out under the untrusted-data header, fences and tags broken.
 */
import { neutralizeFences, neutralizeTags, UNTRUSTED_HEADER } from "../../../shared/untrusted-text.ts";

export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  childIds?: string[];
  backendDOMNodeId?: number;
  properties?: { name: string; value?: { value?: unknown } }[];
}

export const INTERACTIVE_ROLES = new Set([
  "link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "listbox", "treeitem",
]);
const SKIP_ROLES = new Set(["generic", "none", "presentation", "InlineTextBox", "LineBreak", "RootWebArea", "WebArea", "ignored", "group", "paragraph", "section", "Section", "div", "LayoutTable", "LayoutTableRow", "LayoutTableCell"]);

/** The whole snapshot is held to this, so one long page cannot fill the agent's context. */
export const MAX_SNAPSHOT_CHARS = 40_000;

const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface Snapshot {
  text: string;
  /** `eN` → backend DOM node id, valid until the page navigates. */
  refs: Map<string, number>;
}

export function buildSnapshot(nodes: AxNode[], meta: { url: string; title: string }): Snapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let size = 0;
  let truncated = false;

  const visit = (id: string, depth: number) => {
    if (truncated) return;
    const node = byId.get(id);
    if (!node) return;
    const role = text(node.role?.value);
    const name = text(node.name?.value).replace(/\s+/g, " ").trim();
    const value = text(node.value?.value).replace(/\s+/g, " ").trim();
    let next = depth;
    const interactive = INTERACTIVE_ROLES.has(role);
    const show = !node.ignored && !SKIP_ROLES.has(role) && (interactive || name !== "" || role === "heading");
    if (show && !(role === "StaticText" && name === "")) {
      let line = `${"  ".repeat(depth)}- ${role === "StaticText" ? "text" : role}`;
      if (name) line += ` "${clip(name, role === "StaticText" ? 300 : 120)}"`;
      if (value && value !== name) line += ` value="${clip(value, 120)}"`;
      for (const p of node.properties ?? []) {
        if (["checked", "selected", "expanded", "disabled", "focused"].includes(p.name) && p.value?.value === true) line += ` [${p.name}]`;
        if (p.name === "level" && role === "heading") line += ` [h${text(p.value?.value)}]`;
      }
      if (interactive && typeof node.backendDOMNodeId === "number") {
        const ref = `e${refs.size + 1}`;
        refs.set(ref, node.backendDOMNodeId);
        line += ` [ref=${ref}]`;
      }
      size += line.length + 1;
      if (size > MAX_SNAPSHOT_CHARS) { truncated = true; return; }
      lines.push(line);
      next = depth + 1;
    }
    for (const child of node.childIds ?? []) visit(child, next);
  };

  const root = nodes.find((n) => !nodes.some((m) => m.childIds?.includes(n.nodeId))) ?? nodes[0];
  if (root) visit(root.nodeId, 0);
  const body = neutralizeTags(neutralizeFences(lines.join("\n")));
  const head = `Page: ${neutralizeTags(clip(meta.title, 200))} — ${neutralizeTags(clip(meta.url, 500))}`;
  const tail = truncated ? "\n(The page is longer; scroll with browser_scroll and take another snapshot.)" : "";
  return {
    text: `${head}\nInteractive elements carry [ref=eN] for browser_click and browser_type.\n${UNTRUSTED_HEADER}\n\`\`\`\n${body}\n\`\`\`${tail}`,
    refs,
  };
}
