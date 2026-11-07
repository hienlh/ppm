/**
 * The right end of the chat footer's context row, one chip-shaped group: a labelled ring per usage
 * window ("5h 47%", "Wk 52%"), History, and the ··· menu. The rings open the same menu as ···,
 * which holds the account serving
 * this chat (and a drill-in to switch it), AI settings, Team activity, Reload messages and the
 * folded session actions.
 *
 * Everything that used to be a row of its own — the History list, AI settings, the team panel —
 * opens as a popover over the conversation (a bottom sheet on a phone), one at a time.
 *
 * Which account the figures belong to is decided as before: the account this chat claimed or is
 * bound to outranks whatever the usage endpoint reports last, and another account's numbers are
 * never shown under this chat's account name.
 */
import { useEffect, useRef, useState } from "react";
import { History } from "@/lib/icons";
import { MoreHorizontal } from "@/lib/icons";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useNotificationStore } from "@/stores/notification-store";
import { useSessionListStore } from "@/stores/session-list-store";
import { useProjectRef } from "@/stores/session-list-sync-triggers";
import { AISettingsSection } from "@/components/settings/ai-settings-section";
import { openSettings } from "@/components/settings/open-settings";
import { AddAccountDialog } from "@/components/settings/accounts/account-add-dialog";
import { CodexSignInAgainDialog } from "@/components/settings/accounts/codex-sign-in-again-dialog";
import { openLogs } from "@/components/logs/open-logs";
import { useSwitchAccounts } from "@/hooks/use-switch-accounts";
import { percent } from "@/lib/chat-account-switch";
import { bucketResetsAt, formatResetCountdown } from "@/components/settings/accounts/account-usage-format";
import type { SessionInfo, UsageInfo } from "../../../types/chat";
import type { TeamMessageItem } from "@/hooks/use-chat";
import { SessionDebugDialog } from "./session-debug-dialog";
import { TeamActivityPanel } from "./team-activity-panel";
import { ChatHistoryPanel } from "./chat-history-panel";
import { ChatMoreMenu } from "./chat-more-menu";
import { SwitchAccountView } from "./switch-account-view";
import { FooterPopover, FooterPopoverHeader } from "./footer-popover";
import { FOOTER_CLUSTER, FOOTER_GHOST } from "./footer-chip";
import { UsageWindow } from "./usage-meters";
import { AntigravityUsagePanel } from "./antigravity-usage-panel";

type Panel = "history" | "more" | "config" | "team" | "usage" | null;

interface TeamActivityState {
  hasTeams: boolean;
  teamNames: string[];
  messageCount: number;
  unreadCount: number;
}

export interface ChatFooterToolsProps {
  tabId?: string;
  projectName: string;
  usageInfo: UsageInfo;
  /** Antigravity's usage panel: its own refresh and the time of the reading it shows. */
  usageLoading?: boolean;
  lastFetchedAt?: string | null;
  onRefreshUsage?: () => void | Promise<void>;
  sessionId?: string | null;
  providerId?: string;
  /**
   * Account this tab claimed before it had a session, so the menu can name who will answer the
   * first message instead of leaving a blank until after it is sent. Once the session exists its
   * binding takes over and this goes unused.
   */
  pickedAccountLabel?: string | null;
  /** Id of that same account, so Switch account can tick the one serving this chat. */
  pickedAccountId?: string | null;
  /** Route this chat onto another account. */
  onSelectAccount?: (accountId: string, label: string | null) => Promise<string | null>;
  onSelectSession?: (session: SessionInfo) => void;
  /** Inside a design tab: History lists only that design's sessions. */
  historyFilter?: string;
  isConnected?: boolean;
  onReload?: () => void;
  /** Reconnecting or offline: on a narrow chat the ring gives its room to the connection chip. */
  connectionTrouble?: boolean;
  teamActivity?: TeamActivityState;
  teamMessages?: TeamMessageItem[];
  onTeamOpen?: () => void;
}

export function ChatFooterTools({
  tabId, projectName, usageInfo, usageLoading, lastFetchedAt, onRefreshUsage, sessionId, providerId, pickedAccountLabel, pickedAccountId, onSelectAccount,
  onSelectSession, historyFilter, isConnected, onReload, connectionTrouble, teamActivity, teamMessages, onTeamOpen,
}: ChatFooterToolsProps) {
  const [panel, setPanel] = useState<Panel>(null);
  const [moreView, setMoreView] = useState<"main" | "accounts">("main");
  /** Back from Switch account: the main view slides in from the left rather than just appearing. */
  const [returned, setReturned] = useState(false);
  const backToMain = () => { setReturned(true); setMoreView("main"); };
  /** Which of the two triggers opened the menu: only that one shows as pressed. */
  const [moreFrom, setMoreFrom] = useState<"ring" | "dots">("dots");
  const [debugOpen, setDebugOpen] = useState(false);
  const [addAccount, setAddAccount] = useState<{ id: string; label: string } | true | null>(null);
  const [codexReauth, setCodexReauth] = useState<{ id: string; label: string } | null>(null);
  const clusterRef = useRef<HTMLDivElement>(null);
  const project = useProjectRef(projectName);
  // The project's session list feeds History and the linked-sessions chip; fetched once for
  // every open chat of the project and shared through the store.
  useEffect(() => { if (project) void useSessionListStore.getState().ensure(project); }, [project]);
  const hasUnread = useNotificationStore((s) => (sessionId ? s.notifications.has(sessionId) : false));
  const clearForSession = useNotificationStore((s) => s.clearForSession);
  const markUnread = useNotificationStore((s) => s.markUnread);

  const isClaude = !providerId || providerId === "claude";
  const isCodex = providerId === "codex";
  // Antigravity has no Switch account here: its ring opens its own usage panel instead.
  const isAntigravity = providerId === "antigravity";
  const hasAccounts = isClaude || isCodex;
  const providerName = isCodex ? "Codex" : "Claude";
  const switcher = useSwitchAccounts(isCodex ? "codex" : "claude", hasAccounts && panel === "more");

  const toggle = (next: Exclude<Panel, null>) => {
    setPanel((prev) => (prev === next ? null : next));
    setMoreView("main");
    setReturned(false);
  };
  const close = () => setPanel(null);
  // The menu opened from the other trigger stays open and only changes which one is pressed.
  const openMore = (from: "ring" | "dots") => {
    setMoreFrom(from);
    if (panel === "more" && moreFrom !== from) return;
    toggle("more");
  };

  // Account events can arrive before the new quota snapshot: never put the previous account's
  // numbers under the newly selected account's name. Switch account's own reading of the chosen
  // account stands in until the snapshot lands, so the ring follows a pick at once.
  const currentId = pickedAccountId ?? usageInfo.activeAccountId ?? null;
  const usageMatches = !pickedAccountId || pickedAccountId === usageInfo.activeAccountId;
  const listed = switcher.accounts.find((a) => a.id === currentId);
  const fiveHourPct = usageMatches ? percent(usageInfo.fiveHour) : listed?.fiveHourPct ?? null;
  const weekPct = usageMatches ? percent(usageInfo.sevenDay) : listed?.weekPct ?? null;
  const fiveHourResetsAt = usageMatches
    ? bucketResetsAt(usageInfo.session) ?? usageInfo.fiveHourResetsAt ?? null
    : listed?.fiveHourResetsAt ?? null;
  const weekResetsAt = usageMatches
    ? bucketResetsAt(usageInfo.weekly) ?? usageInfo.sevenDayResetsAt ?? null
    : listed?.weekResetsAt ?? null;
  const hasUsage = fiveHourPct != null || weekPct != null;
  // Reconnecting or offline on a narrow chat: the figures are stale, and their room goes to the
  // connection chip.
  const usageHidden = connectionTrouble ? "@max-[420px]/chat:hidden max-md:hidden" : undefined;
  // With no session, the usage endpoint answers with whichever account ran last across every
  // chat; the claim (and, once a turn runs, the account the stream reports) is this chat's own.
  const accountLabel = pickedAccountLabel ?? (usageMatches ? usageInfo.activeAccountLabel : null) ?? listed?.label ?? null;
  const plan = listed?.plan ?? null;
  const who = `${accountLabel ?? "Default account"} · ${providerName}${plan ? ` ${plan}` : ""}`;
  // A quick view: the countdown alone, "5h 47% (resets in 3h 12m)".
  const windowTitle = (label: string, pct: number | null, resetsAt: string | null) => {
    if (pct == null) return null;
    const reset = formatResetCountdown(resetsAt);
    return `${label} ${pct}%${reset ? ` (resets ${reset})` : ""}`;
  };
  const ringTitle = [
    accountLabel,
    windowTitle("5h", fiveHourPct, fiveHourResetsAt),
    windowTitle("Week", weekPct, weekResetsAt),
  ].filter(Boolean).join(" · ");

  return (
    <>
      <div ref={clusterRef} className={FOOTER_CLUSTER} data-footer-cluster="">
        {/* No figure yet, no usage: a "--%" says nothing and takes a slot. The divider belongs to
            the usage part and lives in its branch, so whatever hides one hides both. */}
        {(hasAccounts || isAntigravity) && hasUsage && (
          <>
            <button
              type="button"
              onClick={() => (isAntigravity ? toggle("usage") : openMore("ring"))}
              aria-expanded={isAntigravity ? panel === "usage" : panel === "more" && moreFrom === "ring"}
              aria-haspopup="dialog"
              title={ringTitle}
              aria-label={`Usage: ${ringTitle}`}
              data-usage-ring=""
              className={cn(FOOTER_GHOST, "gap-2 px-2 @max-[420px]/chat:gap-1.5 @max-[420px]/chat:px-1 max-md:gap-1.5 max-md:px-1", usageHidden)}
            >
              <UsageWindow label="5h" pct={fiveHourPct} />
              <UsageWindow label="Wk" pct={weekPct} />
            </button>
            <span aria-hidden="true" data-usage-divider="" className={cn("mx-0.5 h-3.5 w-px shrink-0 bg-border", usageHidden)} />
          </>
        )}
        <button
          type="button"
          data-onboarding="chat-history"
          onClick={() => toggle("history")}
          aria-expanded={panel === "history"}
          aria-haspopup="dialog"
          aria-label="History"
          title="History"
          className={FOOTER_GHOST}
        >
          <History />
        </button>
        <button
          type="button"
          onClick={() => openMore("dots")}
          aria-expanded={(panel === "more" && moreFrom === "dots") || panel === "config" || panel === "team"}
          aria-haspopup="dialog"
          aria-label="More"
          title="More"
          className={FOOTER_GHOST}
        >
          <MoreHorizontal className="!size-4" />
          {(teamActivity?.unreadCount ?? 0) > 0 && (
            <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary shadow-[0_0_0_2px_var(--panel)]" />
          )}
        </button>
      </div>

      <FooterPopover open={panel === "history"} onClose={close} align="right" label="History" anchorRef={clusterRef} className="w-[min(100%,420px)]">
        <FooterPopoverHeader>
          <History className="size-3.5 shrink-0 text-text-3" />
          <b className="text-[13px] font-semibold max-md:text-sm">History</b>
        </FooterPopoverHeader>
        <ChatHistoryPanel tabId={tabId} projectName={projectName} sessionId={sessionId} onSelectSession={onSelectSession} historyFilter={historyFilter} onClose={close} />
      </FooterPopover>

      <FooterPopover open={panel === "more"} onClose={close} align="right" label="Chat menu" anchorRef={clusterRef}>
        {moreView === "accounts" ? (
          <SwitchAccountView
            accounts={switcher.accounts}
            loading={switcher.loading}
            currentId={currentId}
            providerName={providerName}
            onBack={backToMain}
            onPick={onSelectAccount}
            onPicked={backToMain}
            onReauth={(a) => (isCodex ? setCodexReauth({ id: a.id, label: a.label }) : setAddAccount({ id: a.id, label: a.label }))}
            onAddAccount={() => { if (isCodex) { close(); openSettings("accounts"); } else setAddAccount(true); }}
            onManage={() => { close(); openSettings("accounts"); }}
          />
        ) : (
          <div className={cn("flex min-h-0 flex-col", returned && "footer-from-left")} data-more-main="">
            <ChatMoreMenu
              who={hasAccounts ? who : undefined}
              fiveHourPct={fiveHourPct}
              weekPct={weekPct}
              fiveHourResetsAt={fiveHourResetsAt}
              weekResetsAt={weekResetsAt}
              sessionCostUsd={usageInfo.totalCostUsd ?? null}
              accountCount={switcher.loading ? null : Math.max(switcher.accounts.length, 1)}
              onSwitchAccount={hasAccounts ? () => setMoreView("accounts") : undefined}
              providerId={providerId}
              onOpenAISettings={() => setPanel("config")}
              team={teamActivity?.hasTeams ? { unread: teamActivity.unreadCount ?? 0, onOpen: () => { setPanel("team"); onTeamOpen?.(); } } : null}
              isConnected={isConnected}
              onReload={onReload ? () => { close(); onReload(); } : undefined}
              session={sessionId ? {
                hasUnread,
                onToggleUnread: () => { close(); if (hasUnread) clearForSession(sessionId); else markUnread(sessionId, projectName); },
                onOpenDebug: () => { close(); setDebugOpen(true); },
                onShowLogs: () => { close(); openLogs({ chat: sessionId }); },
              } : null}
            />
          </div>
        )}
      </FooterPopover>

      <FooterPopover open={panel === "usage" && isAntigravity} onClose={close} align="right" label="Antigravity usage" anchorRef={clusterRef} className="w-[min(100%,420px)]">
        {isAntigravity && (
          <AntigravityUsagePanel
            usage={usageInfo}
            loading={usageLoading}
            lastFetchedAt={lastFetchedAt}
            onClose={close}
            onReload={onRefreshUsage}
            onSelectAccount={onSelectAccount}
            selectedAccountId={currentId}
          />
        )}
      </FooterPopover>

      <FooterPopover open={panel === "config"} onClose={close} align="right" label="AI settings" anchorRef={clusterRef}>
        <FooterPopoverHeader><b className="text-[13px] font-semibold max-md:text-sm">AI settings</b></FooterPopoverHeader>
        <div className="max-h-[320px] min-h-0 overflow-y-auto px-3 py-2 max-md:max-h-none max-md:flex-1">
          <AISettingsSection compact />
        </div>
      </FooterPopover>

      <FooterPopover open={panel === "team" && !!teamActivity?.hasTeams} onClose={close} align="right" label="Team activity" anchorRef={clusterRef} className="w-[min(100%,420px)]">
        {teamActivity?.hasTeams && (
          <div className="min-h-0 px-3 py-2 max-md:flex-1">
            <TeamActivityPanel teamNames={teamActivity.teamNames} messages={teamMessages ?? []} sessionId={sessionId} projectName={projectName} providerId={providerId} />
          </div>
        )}
      </FooterPopover>

      {sessionId && <SessionDebugDialog sessionId={sessionId} projectName={projectName} open={debugOpen} onOpenChange={setDebugOpen} />}
      {addAccount && (
        <AddAccountDialog
          open
          onOpenChange={(v) => { if (!v) setAddAccount(null); }}
          // The dialog's message is the only place it says a sign-in landed on another account,
          // or that the account is still disabled; it must reach the person.
          onSuccess={(msg) => { setAddAccount(null); switcher.reload(); if (msg) toast(msg); }}
          signInAgainFor={addAccount === true ? undefined : addAccount}
        />
      )}
      {codexReauth && (
        <CodexSignInAgainDialog account={codexReauth} onClose={() => setCodexReauth(null)} onDone={switcher.reload} />
      )}
    </>
  );
}
