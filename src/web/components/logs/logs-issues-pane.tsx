/**
 * What AI made of recent errors and warnings: each group of lines with a cause, a verdict
 * (likely PPM bug, your setup, upstream, expected) and, where it can, a fix. Every card leads
 * back to its lines, into a chat, or into a report; nothing is sent to GitHub from here.
 */
import { useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight, Bug, Check, Clock, ExternalLink, EyeOff, Github, Info, Loader2, Lock, MessageSquare, RefreshCw,
  Settings, Sparkles,
} from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { clockTime, foldRepeats, plural, shortCount } from "@/lib/logs/logs-view-model";
import { ISSUE_CLASSES, type IssueClass, type LogIssue } from "../../../shared/logs-api";
import { rowsToChat, rowsToReport } from "./logs-actions";
import { useLogsReportStore } from "./logs-report-store";
import { CompactLine, SOURCE_ICONS } from "./logs-ui";
import type { CrossPaneProps } from "./logs-state";

const CLASS_INFO: Readonly<Record<IssueClass, { label: string; icon: React.ElementType; chip?: string }>> = {
  bug: { label: "Likely PPM bug", icon: Bug, chip: "e" },
  setup: { label: "Your setup", icon: Settings, chip: "w" },
  upstream: { label: "Upstream", icon: ExternalLink },
  expected: { label: "Expected", icon: Check },
};

const EVIDENCE_ROWS = 3;

function occurrences(it: LogIssue): string {
  const parts = [it.errors > 0 && plural(it.errors, "error"), it.warnings > 0 && plural(it.warnings, "warning")].filter(Boolean);
  return parts.length ? parts.join(" · ") : plural(it.count, "time");
}

export function IssuesPane({ utc, phone, issues, goTo, showInLogs }: CrossPaneProps) {
  const { data, error } = issues;
  const [cls, setCls] = useState<IssueClass | "all">("all");

  if (!data) {
    return (
      <div className="lg-pane">
        <div className="lg-pane-in">
          <div className="lg-empty">
            {error ? <>Could not read what AI found: {error}</> : "Reading what AI found…"}
          </div>
        </div>
      </div>
    );
  }

  const live = data.issues.filter((i) => !i.dismissed);
  const count = (c: IssueClass) => live.filter((i) => i.cls === c).length;
  const nb = count("bug");
  const nc = count("setup") + count("upstream");
  const ne = count("expected");
  const hidden = data.issues.length - live.length;
  const shown = live
    .filter((i) => cls === "all" || i.cls === cls)
    .sort((a, b) => ISSUE_CLASSES.indexOf(a.cls) - ISSUE_CLASSES.indexOf(b.cls) || b.last - a.last);
  const hours = Math.max(1, Math.round((Date.now() - data.windowFrom) / 3_600_000));
  const never = data.analyzedAt === null;
  const title = never
    ? "Not sorted yet"
    : [nb && plural(nb, "likely bug"), nc && `${nc} to check`, ne && `${ne} expected`].filter(Boolean).join(", ") || "Nothing left to look at";

  const draftFrom = (it: LogIssue) => {
    rowsToReport(foldRepeats(it.lines), undefined, true);
    goTo("report");
    void useLogsReportStore.getState().draft();
  };

  const dismiss = (it: LogIssue) => {
    void issues.setDismissed(it.id, true);
    toast(it.cls === "expected" ? "Hidden. The lines stay in Logs." : "Dismissed", {
      action: { label: "Undo", onClick: () => void issues.setDismissed(it.id, false) },
    });
  };

  return (
    <div className="lg-pane" data-testid="logs-issues">
      <div className="lg-pane-in">
        <div className="lg-ai-head">
          <span className="lg-ai-ic"><Sparkles /></span>
          <div className="lg-ai-txt">
            {data.running ? (
              <h3 className="lg-analyzing">
                <Loader2 className="animate-spin" />
                {data.unsorted ? `Reading ${plural(data.unsorted, "error and warning", "errors and warnings")}…` : "Reading the errors and warnings…"}
              </h3>
            ) : <h3>{title}</h3>}
            <p>
              {never ? "Claude can group" : "Claude grouped"} the last {plural(hours, "hour")} of errors and warnings by cause. Info lines are not sent.
            </p>
            {data.error && !data.running && <p className="err">The last run failed: {data.error}</p>}
            <div className="lg-ai-meta">
              <span><Sparkles />{data.model}</span>
              {data.analyzedAt && <span><Clock />Updated {clockTime(data.analyzedAt, utc).slice(0, 5)}</span>}
              {data.lastRun && (
                <span>
                  {plural(data.lastRun.lines, "line")} → {plural(data.lastRun.patterns, "pattern")} · {shortCount(data.lastRun.tokens)} tokens
                </span>
              )}
              {!never && data.unsorted > 0 && !data.running && <span>{plural(data.unsorted, "new line")} not sorted yet</span>}
              <span><Lock />Secrets removed first</span>
            </div>
          </div>
          <div className="lg-ai-act">
            <Button variant="outline" size="sm" disabled={data.running} onClick={() => void issues.analyze(!never)} className={phone ? "min-h-11" : undefined}>
              <RefreshCw />{never ? "Analyze" : "Re-analyze"}
            </Button>
            <label className="lg-autoline">
              <Switch checked={data.auto} onCheckedChange={(on) => void issues.setAuto(on)} />
              Auto
            </label>
          </div>
        </div>

        <div className="lg-filters">
          <FilterChip id="all" label="All" n={live.length} cur={cls} set={setCls} />
          {ISSUE_CLASSES.map((c) => (
            <FilterChip key={c} id={c} label={CLASS_INFO[c].label} chip={CLASS_INFO[c].chip} n={count(c)} cur={cls} set={setCls} />
          ))}
        </div>

        {shown.map((it) => (
          <IssueCard
            key={it.id}
            it={it}
            utc={utc}
            onDraft={() => draftFrom(it)}
            onChat={() => rowsToChat(foldRepeats(it.lines), false)}
            onShow={() => showInLogs(it.lines)}
            onDismiss={() => dismiss(it)}
          />
        ))}
        {!shown.length && (
          <div className="lg-empty">
            {never ? "Press Analyze to sort the errors and warnings." : live.length ? "Nothing in this group." : `No errors or warnings worth a look in the last ${plural(hours, "hour")}.`}
          </div>
        )}

        <div className="lg-muted">
          <Info />
          <span>Nothing goes to GitHub from here: a report opens for you to read first.</span>
          {hidden > 0 && (
            <>
              <span>{plural(hidden, "issue")} hidden</span>
              <button type="button" onClick={() => void issues.undismissAll()}>Show again</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterChip({ id, label, chip, n, cur, set }: {
  id: IssueClass | "all";
  label: string;
  chip?: string;
  n: number;
  cur: IssueClass | "all";
  set(id: IssueClass | "all"): void;
}) {
  return (
    <button type="button" className={cn("lg-chip", chip)} aria-pressed={cur === id} onClick={() => set(id)}>
      {label} <span className="n">{n}</span>
    </button>
  );
}

function IssueCard({ it, utc, onDraft, onChat, onShow, onDismiss }: {
  it: LogIssue;
  utc: boolean;
  onDraft(): void;
  onChat(): void;
  onShow(): void;
  onDismiss(): void;
}) {
  const info = CLASS_INFO[it.cls];
  const ClassIcon = info.icon;
  const AreaIcon = SOURCE_ICONS[it.src];
  const rows = foldRepeats(it.lines);
  return (
    <article className={cn("lg-issue", it.cls === "bug" && "bug")} data-testid="logs-issue">
      <div className="lg-issue-top">
        <span className={`lg-cls ${it.cls}`}><ClassIcon />{info.label}</span>
        <span className="lg-area"><AreaIcon />{it.area}</span>
        <span className="lg-occ">{occurrences(it)} · last {clockTime(it.last, utc).slice(0, 5)}</span>
      </div>
      <h4>{it.title}</h4>
      <p className="lg-why">{it.why}</p>
      {it.fix && <div className="lg-fix"><Info /><span>{it.fix}</span></div>}
      {rows.length > 0 && (
        <div className="lg-evid">
          {rows.slice(0, EVIDENCE_ROWS).map((r) => <CompactLine key={r.key} row={r} utc={utc} trim />)}
          {rows.length > EVIDENCE_ROWS && (
            <div className="r"><span className="t">+ {plural(rows.length - EVIDENCE_ROWS, "more line")}</span></div>
          )}
        </div>
      )}
      <div className="lg-issue-act">
        {it.cls === "bug" && <Button size="sm" onClick={onDraft}><Github />Draft report</Button>}
        <Button variant="outline" size="sm" onClick={onChat}><MessageSquare />Ask in chat</Button>
        <Button variant="ghost" size="sm" onClick={onShow} disabled={!it.lines.length}><ArrowRight />Show in Logs</Button>
        {it.cls !== "bug" && <Button variant="ghost" size="sm" onClick={onDraft}><Github />Report anyway</Button>}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onDismiss}>
          <EyeOff />{it.cls === "expected" ? "Hide" : "Dismiss"}
        </Button>
      </div>
    </article>
  );
}
