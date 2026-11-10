/**
 * One project in the manager table. Wide pane: a row of cells under the table's header. Narrow
 * pane (by the section's own container width): the same cells stacked, each with its own label.
 *
 * The row's menu (right-click, or a long press on a touch screen; the ⋯ button opens it on a
 * desktop too) offers Replace… and Unset. A project with no manager shows "Assign / create".
 */
import { useRef } from "react";
import { MoreHorizontal, Plus } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { ManagerChatBadge } from "@/components/chat/manager-chat-badge";
import { managerModeLabel, type ManagerTableRow } from "@/lib/assistant-manager-table";
import { MANAGER_TOOLS_NEXT_START, type ManagerChatSummary, type ManagerTelegramDetail } from "../../../../shared/assistant-managers";

/** The wide table's columns, shared by the header and every row. */
export const MANAGER_GRID = "@[680px]:grid @[680px]:grid-cols-[minmax(5.5rem,0.7fr)_minmax(8rem,1.1fr)_6.5rem_minmax(11.5rem,1.3fr)_7.5rem_3.5rem_2.75rem] @[680px]:items-center @[680px]:gap-3";

const CELL_LABEL = "text-xs text-text-subtle @[680px]:hidden";

export interface ManagerRowActions {
  onOpen: (manager: ManagerChatSummary) => void;
  onEditRules: (manager: ManagerChatSummary) => void;
  onAssign: (projectName: string) => void;
  onUnset: (manager: ManagerChatSummary) => void;
  onPatch: (manager: ManagerChatSummary, patch: { digest?: boolean; telegramDetail?: ManagerTelegramDetail }) => void;
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 md:min-h-9 @[680px]:min-h-0 @[680px]:justify-start">
      <span className={CELL_LABEL}>{label}</span>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 @[680px]:justify-start">{children}</div>
    </div>
  );
}

export function ManagerChatRow({ row, busy, actions }: { row: ManagerTableRow; busy: boolean; actions: ManagerRowActions }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const m = row.manager;
  const project = <span className="min-w-0 truncate text-sm font-medium" title={row.projectName}>{row.projectName}</span>;

  if (!m) {
    return (
      <div className={`flex items-center justify-between gap-3 px-3.5 py-2.5 ${MANAGER_GRID}`} data-manager-row={row.projectName}>
        {project}
        <span className="hidden text-sm text-text-subtle @[680px]:col-span-3 @[680px]:block">No manager chat</span>
        <Button variant="outline" size="sm" className="min-h-11 shrink-0 gap-1 @[680px]:col-span-3 @[680px]:justify-self-end md:min-h-8"
          onClick={() => actions.onAssign(row.projectName)} aria-label={`Assign or create a manager chat for ${row.projectName}`}>
          <Plus className="size-4" />Assign / create
        </Button>
      </div>
    );
  }

  const openMenu = (e: React.MouseEvent) => {
    const at = (e.currentTarget as HTMLElement).getBoundingClientRect();
    rowRef.current?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.left, clientY: at.bottom }));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div ref={rowRef} className={`select-none space-y-1 px-3.5 py-2.5 ${MANAGER_GRID} @[680px]:space-y-0`} data-manager-row={row.projectName}>
          <div className="flex items-center justify-between gap-2">
            {project}
            <Button variant="ghost" size="icon" className="hidden size-9 md:inline-flex @[680px]:hidden" aria-label={`Manager chat actions for ${row.projectName}`} onClick={openMenu}>
              <MoreHorizontal className="size-4" />
            </Button>
          </div>
          <div className="min-w-0">
            <button type="button" onClick={() => actions.onOpen(m)} className="flex min-h-11 max-w-full items-center gap-1.5 text-left text-sm text-primary hover:underline @[680px]:min-h-8"
              aria-label={`Open the ${row.projectName} manager chat`}>
              <span className="min-w-0 truncate">{m.title || "Untitled chat"}</span>
              <ManagerChatBadge session={{ id: m.sessionId, manager: true }} />
            </button>
            {m.toolsPending && <p className="text-xs text-warning" data-tools-pending="">{MANAGER_TOOLS_NEXT_START}</p>}
          </div>
          <Cell label="Mode"><span className="text-sm text-text-secondary">{managerModeLabel(m.permissionMode)}</span></Cell>
          <Cell label="Rules">
            <span className="shrink-0 font-mono text-xs text-text-secondary">.ppm/manager.md</span>
            <Button variant="outline" size="sm" className="min-h-11 shrink-0 md:min-h-7" disabled={!row.registered}
              onClick={() => actions.onEditRules(m)} aria-label={`Edit the ${row.projectName} rules`}>Edit</Button>
            {m.rulesPending && <span className="shrink-0 rounded bg-warning/15 px-1.5 text-[11px] font-medium leading-5 text-warning" data-rules-pending="">Change waiting</span>}
          </Cell>
          <Cell label="Telegram">
            <Select value={m.telegramDetail} disabled={busy || !row.registered}
              onValueChange={(v) => actions.onPatch(m, { telegramDetail: v as ManagerTelegramDetail })}>
              <SelectTrigger aria-label={`Telegram detail for ${row.projectName}`} className="h-11 w-[7.5rem] md:h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Full</SelectItem>
                <SelectItem value="title">Title only</SelectItem>
              </SelectContent>
            </Select>
          </Cell>
          <Cell label="Digest">
            <Switch aria-label={`Morning digest for ${row.projectName}`} checked={m.digest} disabled={busy || !row.registered}
              onCheckedChange={(digest) => actions.onPatch(m, { digest })} />
          </Cell>
          <Button variant="ghost" size="icon" className="hidden size-9 @[680px]:inline-flex @[680px]:justify-self-end" aria-label={`Manager chat actions for ${row.projectName}`} onClick={openMenu}>
            <MoreHorizontal className="size-4" />
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="md:w-48">
        {row.registered && <ContextMenuItem onClick={() => actions.onAssign(row.projectName)}>Replace…</ContextMenuItem>}
        <ContextMenuItem variant="destructive" onClick={() => actions.onUnset(m)}>Unset</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
