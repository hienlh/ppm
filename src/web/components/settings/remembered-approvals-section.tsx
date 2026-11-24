/**
 * Settings → Approvals: the kinds of request the user chose to have approved without a card, and
 * the one switch for the whole feature. A rule is made only by pressing "Allow & remember" on a
 * card; here it can only be read and removed. Turning the feature off keeps the rules but stops
 * every one of them and takes the button off every card.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { ShieldCheck, Trash2 } from "@/lib/icons";
import { SectionHeader, SwitchRow } from "./settings-rows";
import {
  REMEMBER_SUGGEST_AFTER, REMEMBERED_APPROVALS_CHANGED_EVENT, type RememberedApprovalRule, type RememberedApprovalsState,
} from "../../../shared/remembered-approvals";

const VIA: Record<string, string> = { chat: "in the chat", assistant_card: "on the Assistant's card", telegram: "on Telegram" };

const dayTime = (ms: number) => new Date(ms).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** "Used 4 times, last 14 Nov 10:02" or "Not used yet". */
export function ruleUseLine(rule: Pick<RememberedApprovalRule, "useCount" | "lastUsedAt">): string {
  if (rule.useCount === 0 || rule.lastUsedAt === null) return "Not used yet";
  return `Used ${rule.useCount} time${rule.useCount === 1 ? "" : "s"}, last ${dayTime(rule.lastUsedAt)}`;
}

export function RememberedApprovalsSection() {
  const [state, setState] = useState<RememberedApprovalsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.get<RememberedApprovalsState>("/api/approval-rules"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    // A rule made on another screen (a card in a chat, Telegram) shows up here at once.
    const onChanged = () => void load();
    window.addEventListener(REMEMBERED_APPROVALS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(REMEMBERED_APPROVALS_CHANGED_EVENT, onChanged);
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const byProject = new Map<string, RememberedApprovalRule[]>();
  for (const rule of state?.rules ?? []) byProject.set(rule.projectName, [...(byProject.get(rule.projectName) ?? []), rule]);

  return (
    <div className="space-y-4" data-testid="remembered-approvals-section">
      <SectionHeader title="Approvals">
        Press “Allow &amp; remember” on an approval card and PPM approves that kind of request by itself from then on, in that
        project only, with one line in the chat saying so. After you allow the same kind {REMEMBER_SUGGEST_AFTER} times, the
        card suggests it. Pushes, deploys, deletions, database changes, the vault and anything that leaves the machine are
        never remembered, and no AI can make or change a rule.
      </SectionHeader>
      <div className="rounded-lg border border-border">
        <SwitchRow
          label="Allow & remember"
          note={state?.enabled
            ? "On: cards offer it, and the rules below approve requests by themselves."
            : "Off: every request asks, and no card offers to remember. The rules below are kept."}
          checked={state?.enabled ?? false}
          disabled={busy || !state}
          onChange={(enabled) => void run(() => api.put("/api/approval-rules/enabled", { enabled }))}
        />
      </div>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
      {state && state.rules.length === 0 && (
        <p className="text-sm text-text-subtle" data-testid="remembered-approvals-empty">
          No rules yet. They appear here when you press “Allow &amp; remember” on a card.
        </p>
      )}
      {[...byProject].map(([project, rules]) => (
        <section key={project} className="rounded-lg border border-border">
          <h4 className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-text-subtle">{project}</h4>
          <ul>
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-b-0" data-rule-id={rule.id}>
                <ShieldCheck className="size-4 shrink-0 text-success" />
                <div className="min-w-0 flex-1">
                  <p className={`break-words text-sm ${state?.enabled ? "" : "text-text-subtle line-through"}`}>{rule.label}</p>
                  <p className="text-xs text-text-subtle">
                    Remembered {VIA[rule.createdVia] ?? ""} {dayTime(rule.createdAt)} · {ruleUseLine(rule)}
                  </p>
                </div>
                {/* An icon button: 24px on desktop, 22px on a phone (design guidelines, Mobile-First rule 3). */}
                <button
                  type="button"
                  aria-label={`Remove “${rule.label}”`}
                  title={`Remove “${rule.label}”`}
                  disabled={busy}
                  onClick={() => void run(() => api.del(`/api/approval-rules/${rule.id}`))}
                  className="inline-flex h-6 min-w-[26px] shrink-0 items-center justify-center rounded-full text-error transition-colors disabled:opacity-50 can-hover:hover:bg-surface-hover max-md:h-[22px] max-md:min-w-[22px] [&_svg]:size-3.5"
                >
                  <Trash2 />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
