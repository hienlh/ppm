/**
 * "Switch account", drilled into from the chat's ··· menu: which account serves this chat.
 *
 * Every account is a two-line card with both its 5-hour and weekly bars — the comparison is the
 * point, so a one-line row was rejected. The current account leads and is ticked, then the usable
 * ones with the most headroom. An account that cannot take a turn says why in red and cannot be
 * picked; with five or more accounts those are folded under "Out of usage · N", a search box
 * appears, and the list scrolls inside a header and footer that stay put.
 *
 * Under the bars, how many free resets the account holds and when the nearest expires; a tap
 * there opens Settings on that account rather than picking it.
 *
 * Picking is refused here first (the person pressed something and is owed the reason), then by the
 * server, whose refusal is shown in the same strip. A signed-out card is not dead: a tap on it
 * starts signing it in again.
 */
import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronLeft, Loader2, Lock, Plus, RotateCcw, Search, Settings, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { matchesAccountQuery, orderSwitchAccounts, type SwitchAccount } from "@/lib/chat-account-switch";
import { UsageTrack } from "./usage-meters";
import { formatResetLine } from "@/components/settings/accounts/account-usage-format";
import { resetDay } from "@/components/settings/accounts/account-resets";
import { FooterButton, FooterPopoverFooter, FooterPopoverHeader } from "./footer-popover";

/** From this many accounts on, the view searches and folds the unusable ones away. */
export const MANY_ACCOUNTS = 5;

export function SwitchAccountView({
  accounts, loading, currentId, providerName, onBack, onPick, onPicked, onReauth, onAddAccount, onManage, onOpenResets,
}: {
  accounts: SwitchAccount[];
  loading: boolean;
  currentId: string | null;
  /** "Claude", "Codex" — the only provider listed. */
  providerName: string;
  onBack: () => void;
  /** Route this chat onto the account; resolves to the server's refusal, or null. Absent: read-only. */
  onPick?: (id: string, label: string) => Promise<string | null>;
  /** The pick landed: the menu goes back to its main view. */
  onPicked: () => void;
  onReauth?: (account: SwitchAccount) => void;
  onAddAccount: () => void;
  onManage: () => void;
  /** Show this account's free resets in Settings, where they are spent. */
  onOpenResets?: (account: SwitchAccount) => void;
}) {
  const [query, setQuery] = useState("");
  const [foldOpen, setFoldOpen] = useState(false);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const many = accounts.length >= MANY_ACCOUNTS;
  const { usable, outOfUsage } = orderSwitchAccounts(accounts, currentId);
  const shownUsable = usable.filter((a) => matchesAccountQuery(a, query));
  const shownOut = outOfUsage.filter((a) => matchesAccountQuery(a, query));
  // A search reaches the folded group too, so it opens while searching.
  const outOpen = foldOpen || query.trim() !== "";

  const pick = async (a: SwitchAccount) => {
    if (a.refusal) {
      if (a.signedOut && onReauth) onReauth(a);
      else setError(`Cannot switch to ${a.label} — ${a.refusal.toLowerCase()}.`);
      return;
    }
    if (a.id === currentId) { onPicked(); return; }
    // The chat is still being prepared or its first message is on its way: say so, not nothing.
    if (!onPick) { setError("The account can be changed once this chat has finished starting."); return; }
    setPickingId(a.id);
    setError(null);
    try {
      const refused = await onPick(a.id, a.label);
      if (refused) setError(refused);
      else setTimeout(onPicked, 260);
    } finally {
      setPickingId(null);
    }
  };

  const card = (a: SwitchAccount) => (
    <AccountCard
      key={a.id}
      account={a}
      active={a.id === currentId}
      picking={pickingId === a.id}
      onPick={() => void pick(a)}
      onOpenResets={onOpenResets ? () => onOpenResets(a) : undefined}
    />
  );

  return (
    <div className="footer-from-right flex min-h-0 flex-1 flex-col" data-switch-account-view="">
      <FooterPopoverHeader>
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="-my-1 -ml-1.5 grid size-7 place-items-center rounded-md text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-text max-md:size-11"
        >
          <ChevronLeft className="size-3.5 max-md:size-4" />
        </button>
        <b className="text-[13px] font-semibold max-md:text-sm">Switch account</b>
        <span className="ml-auto text-[11px] text-text-3">
          {many ? `${accounts.length} accounts · ${providerName}` : "for this chat"}
        </span>
      </FooterPopoverHeader>

      {error && (
        <div role="alert" className="flex items-start gap-2 border-b border-border-soft bg-error/5 px-3 py-2 text-[11px] text-error max-md:text-xs">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0 rounded p-0.5 can-hover:hover:bg-error/10">
            <X className="size-3" />
          </button>
        </div>
      )}

      {many && (
        <label className="mx-2 mt-2 flex h-8 shrink-0 items-center gap-2 rounded-lg border border-border bg-panel px-2.5 text-text-3 focus-within:border-accent-wash-border max-md:h-11">
          <Search className="size-3.5 shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find an account"
            aria-label="Find an account"
            className="min-w-0 flex-1 border-0 bg-transparent text-xs text-text outline-none placeholder:text-text-3 max-md:text-base"
          />
        </label>
      )}

      <div className={cn("min-h-0 overflow-y-auto overscroll-contain", many ? "max-h-[300px] px-1 pb-1 max-md:max-h-none max-md:flex-1" : "max-md:flex-1")}>
        {loading && accounts.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-4 text-[11px] text-text-3"><Loader2 className="size-3.5 animate-spin" /> Loading accounts…</div>
        ) : accounts.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-text-3">No {providerName} accounts yet. Add one to choose which serves this chat.</p>
        ) : (
          <>
            {many && shownUsable.length > 0 && (
              <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-3">Current, then most headroom</div>
            )}
            <div className="flex flex-col gap-1.5 p-2">
              {shownUsable.map(card)}
              {!many && outOfUsage.map(card)}
            </div>
            {many && shownOut.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setFoldOpen(!foldOpen)}
                  aria-expanded={outOpen}
                  className="flex min-h-[34px] w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] can-hover:hover:bg-surface-hover max-md:min-h-11 max-md:text-sm"
                >
                  <Lock className="size-4 text-text-3" />
                  Out of usage
                  <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-text-3">
                    {shownOut.length}
                    <ChevronDown className={cn("size-3 transition-transform duration-150 motion-reduce:transition-none", outOpen && "rotate-180")} />
                  </span>
                </button>
                <FoldGroup open={outOpen}>
                  <div className="flex flex-col gap-1.5 px-1 pb-1.5 pt-1">{shownOut.map(card)}</div>
                </FoldGroup>
              </>
            )}
            {many && shownUsable.length === 0 && shownOut.length === 0 && (
              <p className="m-2 text-center text-xs text-text-3">No account matches.</p>
            )}
          </>
        )}
      </div>

      <FooterPopoverFooter>
        <FooterButton onClick={onAddAccount}><Plus />Add account</FooterButton>
        <FooterButton onClick={onManage} className="ml-auto"><Settings />Manage in Settings</FooterButton>
      </FooterPopoverFooter>
    </div>
  );
}

/** Height that animates open and closed through grid rows; instant under reduced motion. */
export function FoldGroup({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
      inert={!open}
    >
      <div className={cn("min-h-0 overflow-hidden transition-opacity duration-150 motion-reduce:transition-none", open ? "opacity-100" : "opacity-0")}>
        {children}
      </div>
    </div>
  );
}

function AccountCard({ account: a, active, picking, onPick, onOpenResets }: {
  account: SwitchAccount;
  active: boolean;
  picking: boolean;
  onPick: () => void;
  onOpenResets?: () => void;
}) {
  const blocked = !!a.refusal;
  // The resets line is a button of its own, so the card is a box holding two buttons rather than
  // one button (a button inside a button is invalid and would pick the account on every tap).
  return (
    <div
      className={cn(
        "flex w-full flex-col rounded-[10px] border transition-[background-color,border-color] duration-150",
        active ? "border-accent-wash-border bg-accent-wash" : "border-border-soft bg-panel can-hover:hover:border-border",
      )}
    >
      <button
        type="button"
        onClick={onPick}
        aria-disabled={blocked && !a.signedOut ? true : undefined}
        aria-current={active ? "true" : undefined}
        data-account-row={a.id}
        title={a.signedOut ? `${a.label} — sign in again` : a.refusal ? `${a.label} — ${a.refusal}` : a.label}
        className={cn(
          "flex w-full flex-col gap-2 rounded-[10px] p-2.5 text-left transition-transform duration-150",
          blocked && !a.signedOut ? "cursor-not-allowed" : "motion-safe:active:scale-[0.97]",
          "max-md:min-h-11",
        )}
      >
        <span className="flex items-center gap-2">
          <span className={cn("min-w-0 truncate text-[13px] font-medium", blocked ? "text-text-3" : "text-text")}>{a.label}</span>
          {a.plan && (
            <span className="shrink-0 rounded-full border border-border-soft bg-panel-2 px-1.5 py-px text-[10px] font-semibold text-text-2">{a.plan}</span>
          )}
          <span className={cn(
            "ml-auto inline-flex shrink-0 text-primary transition-[opacity,transform] duration-200 motion-reduce:transition-none",
            active || picking ? "scale-100 opacity-100" : "scale-[0.6] opacity-0",
          )}>
            {picking ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
          </span>
        </span>
        {a.refusal && (
          <span className={cn("-mt-1 whitespace-nowrap text-[11px] text-error", a.signedOut && "underline decoration-error/40 underline-offset-2")}>{a.refusal}</span>
        )}
        {!a.signedOut && (
          <span className="grid grid-cols-2 items-start gap-2.5">
            <Meter label="5h" pct={a.fiveHourPct} resetsAt={a.fiveHourResetsAt} dim={blocked} />
            <Meter label="Week" pct={a.weekPct} resetsAt={a.weekResetsAt} dim={blocked} />
          </span>
        )}
      </button>
      {a.resets && <ResetsLine resets={a.resets} onOpen={onOpenResets} />}
    </div>
  );
}

/**
 * "⟲ 3 resets · next expires Dec 11" under the bars. Drawn on every card, "No free resets"
 * included, so the cards stay one height. A tap opens Settings on this account, where the resets
 * are listed one by one and spent; nothing is spent from the chat.
 */
function ResetsLine({ resets, onOpen }: { resets: NonNullable<SwitchAccount["resets"]>; onOpen?: () => void }) {
  const box = "-mt-1 mx-1 mb-1 flex min-h-6 items-center gap-1 self-start rounded-md px-1.5 text-[11px] max-md:min-h-11";
  if (resets.count === 0 || !onOpen) {
    return (
      <span data-account-resets="" className={cn(box, "text-text-3")}>
        <RotateCcw className="size-3 shrink-0" aria-hidden />
        {resets.count === 0 ? "No free resets" : `${resets.count} reset${resets.count === 1 ? "" : "s"}`}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-account-resets=""
      onClick={onOpen}
      title="See them in Settings"
      className={cn(box, "text-text-3 can-hover:hover:bg-surface-hover")}
    >
      <RotateCcw className="size-3 shrink-0 text-primary" aria-hidden />
      <span className="text-primary">{resets.count} reset{resets.count === 1 ? "" : "s"}</span>
      {resets.nextExpiresAt && <span>· next expires {resetDay(resets.nextExpiresAt)}</span>}
    </button>
  );
}

/**
 * Label and figure take fixed columns, so every bar on every card is the same length: sized by
 * their own text, "5h" left a longer bar than "Week", and "100%" a shorter one than "8%".
 * Under the bar, when it resets — countdown and clock, "Resets in 3h 12m · 03:52" — in red once
 * the bar is full, since that line is then the answer to "when can I use it again".
 */
function Meter({ label, pct, resetsAt, dim }: { label: string; pct: number | null; resetsAt: string | null; dim: boolean }) {
  const reset = formatResetLine(resetsAt);
  return (
    <span className="grid grid-cols-[30px_minmax(0,1fr)_32px] items-center gap-x-1.5 gap-y-0.5 whitespace-nowrap text-[11px] text-text-3">
      <span>{label}</span>
      <UsageTrack pct={pct} />
      <span className={cn("text-right tabular-nums", dim ? "text-text-3" : "text-text-2")}>{pct != null ? `${pct}%` : "--%"}</span>
      {reset && (
        <span data-account-reset="" className={cn("col-span-3 truncate text-[10.5px] tabular-nums", (pct ?? 0) >= 100 ? "font-medium text-error" : "text-text-3")}>{reset}</span>
      )}
    </span>
  );
}
