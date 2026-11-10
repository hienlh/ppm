/**
 * The rows of Settings → PPM Assistant → Manager chats: every registered project, with its
 * manager when it has one, then any manager whose project was removed from PPM (it keeps its row
 * under its folder's name until unassigned). Pure, so the table's contents are testable alone.
 */
import { isAssistantProject } from "../../shared/assistant-project";
import type { ManagerChatSummary } from "../../shared/assistant-managers";
import type { ManagerMode } from "../../shared/assistant-settings";

export interface ManagerTableRow {
  projectName: string;
  manager: ManagerChatSummary | null;
  /** False for a manager whose project is no longer registered: it can only be unassigned. */
  registered: boolean;
}

export function managerTableRows(projects: ReadonlyArray<{ name: string }>, managers: readonly ManagerChatSummary[]): ManagerTableRow[] {
  const byProject = new Map(managers.map((m) => [m.projectName, m]));
  const rows: ManagerTableRow[] = projects
    .filter((p) => !isAssistantProject(p.name))
    .map((p) => ({ projectName: p.name, manager: byProject.get(p.name) ?? null, registered: true }));
  const listed = new Set(rows.map((r) => r.projectName));
  for (const m of managers) {
    if (!listed.has(m.projectName)) rows.push({ projectName: m.projectName, manager: m, registered: false });
  }
  return rows;
}

const MODE_LABELS: Record<string, string> = {
  plan: "Plan",
  default: "Ask",
  acceptEdits: "Accept edits",
  bypassPermissions: "Bypass permissions",
};

/** A permission mode as the composer chip names it. */
export function managerModeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

export const MANAGER_MODE_OPTIONS: ReadonlyArray<{ id: ManagerMode; label: string }> = [
  { id: "plan", label: "Plan" },
  { id: "default", label: "Ask" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "bypassPermissions", label: "Bypass permissions" },
];

/** What choosing bypass as the default for new manager chats means, said before it is saved. */
export const BYPASS_DEFAULT_CONSEQUENCE =
  "New manager chats will run without approval prompts, and PPM Assistant messages them without asking";

/** The rules column's hint: what PPM guards and what it leaves to the manager. */
export const RULES_GUARD_HINT =
  "PPM guards only .ppm/manager.md. Files it points to are the manager's own working files.";
