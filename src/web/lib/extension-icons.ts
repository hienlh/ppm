/**
 * The icons an extension may ask for by name, and the glyph each name draws.
 *
 * A manifest names an icon the way VS Code's does — `{ "command":
 * "git-graph.view", "icon": "git-branch" }` — and without a table like this one
 * the name is inert: every panel an extension opens falls back to the generic
 * puzzle piece, so a strip holding the graph, a blame, a file history and a
 * rebase shows four identical tabs.
 *
 * Kebab-case, the way a manifest writes it. A name with no entry here is not an
 * error — the caller's fallback draws instead — but `tests/unit/web/
 * extension-icons.test.ts` fails when a *bundled* extension asks for one,
 * because that is the case where the puzzle piece is a bug rather than a
 * default.
 */
import {
  Check, CircleHelp, Clock, Database, FileCode, FileDiff, GitBranch, GitCommitHorizontal, GitPullRequest, Globe,
  History, ListOrdered, MessageSquare, Pencil, Plus, RefreshCw, Search, Settings, ShieldAlert, Square, Sun,
  Tag, Terminal, Timer, Trash2, TriangleAlert, Users, XCircle,
} from "@/lib/icons";
import type { ElementType } from "react";
import type { ExtensionContributes } from "../../types/extension.ts";

export const EXTENSION_ICONS: Record<string, ElementType> = {
  // Named by the panels the bundled Git Graph contributes.
  "git-branch": GitBranch,
  "git-commit": GitCommitHorizontal,
  // Fluent draws no compare glyph and PPM re-exports no lucide one, so a
  // comparison of two refs wears the same icon as any other diff in the app.
  "git-compare": FileDiff,
  history: History,
  users: Users,
  "list-ordered": ListOrdered,
  // Named by tree-view item actions.
  refresh: RefreshCw,
  edit: Pencil,
  trash: Trash2,
  plus: Plus,
  search: Search,
  // General-purpose names an extension is likely to reach for.
  database: Database,
  terminal: Terminal,
  settings: Settings,
  "file-code": FileCode,
  globe: Globe,
  // Row icons and row actions of a to-do style tree (done, snooze, why an item is listed).
  check: Check,
  clock: Clock,
  question: CircleHelp,
  shield: ShieldAlert,
  stop: Square,
  // Fluent has no hourglass; the timer reads as "waiting for a while" the same way.
  hourglass: Timer,
  "git-pull-request": GitPullRequest,
  // Fluent has no ticket glyph; an issue key is a tag on the work.
  ticket: Tag,
  message: MessageSquare,
  sun: Sun,
  warning: TriangleAlert,
  "x-circle": XCircle,
};

/** The glyph for a manifest icon name, or undefined for one nothing draws. */
export function extensionIcon(name: string | undefined | null): ElementType | undefined {
  return name ? EXTENSION_ICONS[name] : undefined;
}

/**
 * The icon of the command that opens a panel.
 *
 * A panel's viewType *is* its command id — `registerViewCommand` requires the
 * two to match, because the frontend pairs them by slug — so the manifest entry
 * that names the command already names the panel, and an extension needs no
 * second place to declare one. The tab carries the slug (a trailing `.view`
 * stripped), so both forms are compared.
 */
export function viewTypeIcon(
  contributions: ExtensionContributes | null | undefined,
  viewType: string | undefined,
): ElementType | undefined {
  if (!contributions?.commands || !viewType) return undefined;
  const command = contributions.commands.find(
    (c) => c.command === viewType || c.command.replace(/\.view$/, "") === viewType,
  );
  return extensionIcon(command?.icon);
}
