/**
 * The chat's ··· menu, main view — what the toolbar used to spread across a row of chips, now one
 * tap away: the account serving this chat with its 5-hour and weekly meters, Switch account (a
 * drill-in), AI settings, Team activity, and Reload messages with the connection's state.
 *
 * The three rarely used session actions (mark unread, debug info, this chat's logs) are folded
 * under "More" and open in place, so the menu stays short until they are wanted.
 */
import { useState, type ReactNode } from "react";
import { BellOff, Bug, ChevronDown, ChevronRight, Circle, MoreHorizontal, RefreshCw, ScrollText, Settings2, Users } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { ProviderBadge } from "./provider-selector";
import { UsageMeter } from "./usage-meters";
import { FoldGroup } from "./switch-account-view";

export interface ChatMoreMenuProps {
  /** "Victor 2 (Nxsys) · Claude Max" — who serves this chat. Absent for a provider with no accounts. */
  who?: string | null;
  fiveHourPct?: number | null;
  weekPct?: number | null;
  /** When each window resets (ISO); the meters show the countdown beside the figure. */
  fiveHourResetsAt?: string | null;
  weekResetsAt?: string | null;
  /** Shown under the meters when the provider reports spend. */
  sessionCostUsd?: number | null;
  /** How many accounts the provider has, once known. */
  accountCount?: number | null;
  onSwitchAccount?: () => void;
  providerId?: string;
  onOpenAISettings: () => void;
  team?: { unread: number; onOpen: () => void } | null;
  isConnected?: boolean;
  onReload?: () => void;
  /** The session actions; absent before the chat has a session. */
  session?: {
    hasUnread: boolean;
    onToggleUnread: () => void;
    onOpenDebug: () => void;
    onShowLogs: () => void;
  } | null;
}

export function ChatMoreMenu({
  who, fiveHourPct = null, weekPct = null, fiveHourResetsAt = null, weekResetsAt = null, sessionCostUsd, accountCount, onSwitchAccount, providerId,
  onOpenAISettings, team, isConnected, onReload, session,
}: ChatMoreMenuProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const showsUsage = who !== undefined;
  return (
    <div className="flex min-h-0 flex-col overflow-y-auto" data-chat-more-menu="">
      {showsUsage && (
        <>
          <div className="px-2 pb-2.5 pt-2 max-md:px-4">
            <div className="mb-2 truncate text-[11px] text-text-3">{who ?? "Usage"}</div>
            <UsageMeter label="5 hours" pct={fiveHourPct} resetsAt={fiveHourResetsAt} />
            <UsageMeter label="Week" pct={weekPct} resetsAt={weekResetsAt} />
            {sessionCostUsd != null && (
              <div className="mt-1.5 text-[11px] tabular-nums text-text-3">This session ${sessionCostUsd.toFixed(4)}</div>
            )}
          </div>
          <Sep />
        </>
      )}
      <div className="p-1">
        {onSwitchAccount && (
          <MenuItem icon={<Users />} onClick={onSwitchAccount} hint={<>{accountCount != null && `${accountCount} account${accountCount === 1 ? "" : "s"}`}<ChevronRight className="!size-3" /></>}>
            Switch account
          </MenuItem>
        )}
        <MenuItem
          icon={<Settings2 />}
          onClick={onOpenAISettings}
          hint={providerId && providerId !== "mock" ? <><ProviderBadge providerId={providerId} size="sm" /><span className="capitalize">{providerId}</span></> : undefined}
        >
          AI settings
        </MenuItem>
        {team && (
          <MenuItem icon={<Users />} onClick={team.onOpen} hint={team.unread > 0 ? <span className="size-2 rounded-full bg-primary" aria-label={`${team.unread} unread`} /> : undefined}>
            Team activity
          </MenuItem>
        )}
        {onReload && (
          <>
            <Sep />
            <MenuItem
              icon={<RefreshCw />}
              onClick={onReload}
              hint={<><span className={cn("size-2 rounded-full", isConnected ? "bg-success" : "bg-error")} />{isConnected ? "Connected" : "Disconnected"}</>}
            >
              Reload messages
            </MenuItem>
          </>
        )}
        {session && (
          <>
            <MenuItem
              icon={<MoreHorizontal />}
              onClick={() => setMoreOpen(!moreOpen)}
              expanded={moreOpen}
              hint={<>Unread, debug, logs<ChevronDown className={cn("!size-3 transition-transform duration-150 motion-reduce:transition-none", moreOpen && "rotate-180")} /></>}
            >
              More
            </MenuItem>
            <FoldGroup open={moreOpen}>
              <div className="pl-3">
                <MenuItem
                  icon={session.hasUnread ? <BellOff className="!text-warning" /> : <Circle className="fill-current !text-primary" />}
                  onClick={session.onToggleUnread}
                >
                  {session.hasUnread ? "Mark as read" : "Mark as unread"}
                </MenuItem>
                <MenuItem icon={<Bug />} onClick={session.onOpenDebug}>Session debug info</MenuItem>
                <MenuItem icon={<ScrollText />} onClick={session.onShowLogs}>Show logs for this chat</MenuItem>
              </div>
            </FoldGroup>
          </>
        )}
      </div>
    </div>
  );
}

function Sep() {
  return <div className="mx-0 my-1 h-px shrink-0 bg-border-soft" />;
}

function MenuItem({ icon, hint, onClick, expanded, children }: {
  icon: ReactNode;
  hint?: ReactNode;
  onClick: () => void;
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className="flex min-h-[34px] w-full items-center gap-2.5 rounded-md px-2 py-[7px] text-left text-[13px] text-text transition-[background-color,transform] duration-150 motion-safe:active:scale-[0.97] can-hover:hover:bg-surface-hover max-md:min-h-11 max-md:px-3 max-md:text-sm [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-text-3"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[11px] text-text-3 [&_svg]:size-3.5">{hint}</span>}
    </button>
  );
}
