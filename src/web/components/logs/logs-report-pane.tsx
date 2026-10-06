/**
 * A GitHub issue put together from log lines: AI drafts the words, the person edits them,
 * chooses what personal detail comes out, and opens the issue on GitHub to submit it there.
 * Nothing is posted from PPM. The body the preview shows, the one the link carries and the one
 * Copy as Markdown copies are the same `reportBody` call, the preview only marking what was
 * taken out.
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ArrowRight, CheckCircle2, Copy, Github, Info, Loader2, Lock, Plus, RefreshCw, ScrollText, ShieldCheck, Sparkles,
  TriangleAlert, X, Check,
} from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { useProjectStore } from "@/stores/project-store";
import { plural, timeSpan } from "@/lib/logs/logs-view-model";
import {
  ISSUE_URL_LIMIT, SNIPPET_CONTEXTS, issueUrl, reportBody, reportMarkdown, snippetCount, snippetLines,
  type ReportSnippet,
} from "@/lib/logs/logs-report";
import { logSourceLabel } from "../../../shared/logs-model";
import { LOGS_ISSUE_REPO, type DuplicateSearchResult } from "../../../shared/logs-api";
import { redactLogText, type RedactOptions } from "../../../shared/log-redact";
import { fetchRepoLabels, searchDuplicates } from "./logs-client";
import { loadReportEnvironment, useLogsReportStore, type PrivacySwitches } from "./logs-report-store";
import { CompactLine, SOURCE_ICONS } from "./logs-ui";
import type { CrossPaneProps } from "./logs-state";

const PRIVACY_ROWS: ReadonlyArray<[keyof PrivacySwitches, string, string]> = [
  ["home", "Home folder", "/home/you → ~"],
  ["email", "Email addresses", "you@example.com → <email>"],
  ["chats", "Chat ids", "53952680-0b07-… → 53952680"],
  ["projects", "Project names", "my-app → <project>"],
];

/** Wait this long after the title stops changing before asking GitHub for look-alikes. */
const DUPLICATE_DEBOUNCE_MS = 700;

let labelsRead: Promise<string[]> | null = null;
function loadLabels(): Promise<string[]> {
  labelsRead ??= fetchRepoLabels().catch(() => {
    labelsRead = null;
    return [];
  });
  return labelsRead;
}

/** `Claude Haiku 4.5` → `Haiku 4.5`, for the chip beside the button. */
const shortModel = (model: string) => model.replace(/^Claude\s+/i, "");

/** A body line with what was taken out marked, as `redactLogText(…, mark)` delimits it. */
function marked(line: string): ReactNode[] {
  return line.split(/(\u0001[^\u0002]*\u0002)/).map((part, i) => (part.startsWith("\u0001")
    ? <mark key={i}>{part.slice(1, -1)}</mark>
    : <Fragment key={i}>{part}</Fragment>));
}

function previewLine(line: string): ReactNode {
  if (line.startsWith("### ")) return <span className="h">{marked(line)}</span>;
  if (/^(<\/?(details|summary|sub)\b|`{3,}|~{3,})/.test(line)) return <span className="c">{marked(line)}</span>;
  return marked(line);
}

export function ReportPane({ utc, phone, issues, goTo, showInLogs }: CrossPaneProps) {
  const store = useLogsReportStore();
  const { snippets, fields, status, stale, fresh, error, model, basis, view, envOff, priv } = store;
  const projectNames = useProjectStore((s) => s.projects).map((p) => p.name);
  const [environment, setEnvironment] = useState<Array<[string, string]> | null>(null);
  const [labels, setLabels] = useState<string[] | null>(null);
  const [dupes, setDupes] = useState<DuplicateSearchResult | null>(null);

  useEffect(() => {
    let alive = true;
    loadReportEnvironment().then((rows) => { if (alive) setEnvironment(rows); }, () => { if (alive) setEnvironment([]); });
    void loadLabels().then((l) => { if (alive) setLabels(l); });
    return () => { alive = false; };
  }, []);

  const redact: RedactOptions = useMemo(
    () => ({ home: priv.home, email: priv.email, chats: priv.chats, projects: priv.projects ? projectNames : [] }),
    // The names, not the array: the store hands out a new array on every project update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [priv.home, priv.email, priv.chats, priv.projects, projectNames.join("\n")],
  );
  const envRows = useMemo(() => (environment ?? []).filter(([k]) => !envOff.includes(k)), [environment, envOff]);
  const title = redactLogText(fields.title.trim(), redact);
  const body = useMemo(() => reportBody({ fields, snippets, environment: envRows, redact }), [fields, snippets, envRows, redact]);
  const fullUrl = issueUrl(title, fields.labels, body);
  const over = fullUrl.length > ISSUE_URL_LIMIT;
  const openUrl = over ? issueUrl(title, fields.labels, null) : fullUrl;
  const lines = snippets.reduce((a, s) => a + snippetCount(s), 0);
  const busy = status === "drafting";

  // Look-alike open issues, once the title settles.
  const query = fields.title.trim();
  useEffect(() => {
    setDupes(null);
    if (query.length < 8) return;
    let alive = true;
    const t = setTimeout(() => {
      searchDuplicates(redactLogText(query, redact)).then((r) => { if (alive) setDupes(r); }, () => { /* no line, rather than a wrong one */ });
    }, DUPLICATE_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, redact]);

  if (!snippets.length && status === "none") {
    return (
      <div className="lg-pane">
        <div className="lg-rep-empty" data-testid="logs-report-empty">
          <div className="lg-ai-ic"><Github /></div>
          <h3>Nothing in the report yet</h3>
          <p>Select lines in Logs and choose <b>Add to report</b>. Or open Issues: AI may already have found something worth reporting.</p>
          <div className="row">
            <Button variant="outline" size="sm" className={cn(phone && "min-h-11")} onClick={() => goTo("logs")}><ScrollText />Go to Logs</Button>
            <Button size="sm" className={cn(phone && "min-h-11")} onClick={() => goTo("issues")}><Sparkles />See what AI found</Button>
          </div>
        </div>
      </div>
    );
  }

  const onOpen = () => {
    if (over) {
      void copyToClipboard(body).then((ok) => {
        if (ok) toast.success("Body copied. Paste it into the issue that just opened.");
        else toast.error("Could not copy the body. Use Copy as Markdown, then paste it into the issue.");
      });
    } else toast.success("Opened the new issue on GitHub. Check it there, then press Submit.");
  };
  const copyMarkdown = async () => {
    if (await copyToClipboard(reportMarkdown(title, body))) toast.success("Copied the issue as Markdown");
    else toast.error("Could not copy the issue");
  };
  const removeSnippet = (s: ReportSnippet) => {
    const r = store.remove(s.id);
    if (!r) return;
    toast(`Removed ${plural(snippetCount(s), "line")} from the report`, {
      action: { label: "Undo", onClick: () => useLogsReportStore.getState().restore(r.snippet, r.index) },
    });
  };
  const draft = () => void store.draft();
  const modelName = model ?? issues.data?.model ?? "Claude Haiku 4.5";
  const aiMark = status === "done" ? <Sparkles className="ai" /> : null;
  const pct = Math.min(100, (fullUrl.length / ISSUE_URL_LIMIT) * 100);

  const openButton = (label: string, className?: string) => (
    <Button asChild className={className}>
      <a href={openUrl} target="_blank" rel="noopener noreferrer" onClick={onOpen}>
        <Github />{label}
      </a>
    </Button>
  );

  return (
    <>
      <div className="lg-pane" data-testid="logs-report">
        <div className="lg-rep">
          <div className="lg-rep-main">
            <div className="lg-rep-top">
              <h3><Github />New issue for {LOGS_ISSUE_REPO}</h3>
              <div className="lg-seg" role="tablist" aria-label="Write or preview">
                <button type="button" role="tab" aria-selected={view === "write"} onClick={() => store.setView("write")}>Write</button>
                <button type="button" role="tab" aria-selected={view === "preview"} onClick={() => store.setView("preview")}>Preview</button>
              </div>
              <p>Nothing is sent from here. GitHub opens with this filled in, and you submit it there.</p>
            </div>

            {view === "preview" ? (
              <pre className="lg-md" data-testid="logs-report-preview">
                <span className="c">Title: </span>{fields.title.trim() ? marked(redactLogText(fields.title.trim(), redact, true)) : <span className="c">(no title yet)</span>}{"\n"}
                <span className="c">Labels: {fields.labels.join(", ") || "none"}</span>{"\n\n"}
                {reportBody({ fields, snippets, environment: envRows, redact, mark: true }).split("\n").map((line, i) => (
                  <Fragment key={i}>{previewLine(line)}{"\n"}</Fragment>
                ))}
              </pre>
            ) : (
              <>
                {status === "done" ? (
                  <div className="lg-aidone">
                    <CheckCircle2 />
                    <span>
                      {error ? <span className="text-error">Could not write it again: {error}</span>
                        : stale ? "You changed the lines after Claude wrote this."
                          : <>Drafted by <b>{modelName}</b> from {plural(basis, "line")}. Read it over before sending.</>}
                    </span>
                    <Button variant="ghost" size="xs" className="ml-auto" onClick={draft}>
                      <RefreshCw />{stale ? "Write again" : "Redo"}
                    </Button>
                  </div>
                ) : (
                  <div className="lg-aibox">
                    <span className="lg-ai-ic"><Sparkles /></span>
                    <div className="lg-aibox-txt">
                      <b>{busy ? "Writing the report…" : "Let AI write it up"}</b>
                      <span>
                        {busy
                          ? `Reading ${plural(lines, "line")} and the environment.`
                          : `Claude reads the ${plural(lines, "line")} below and fills in the title, what happened, the steps and what you expected.`}
                      </span>
                      {error && !busy && <span className="err">Could not write it: {error}</span>}
                    </div>
                    <div className="lg-aibox-act">
                      {busy ? (
                        <span className="lg-analyzing"><Loader2 className="animate-spin" />Drafting</span>
                      ) : (
                        <>
                          <span className="lg-modelchip"><Sparkles />{shortModel(modelName)}</span>
                          <Button size="sm" className={cn(phone && "min-h-11")} disabled={!lines} onClick={draft}><Sparkles />Draft with AI</Button>
                        </>
                      )}
                    </div>
                  </div>
                )}

                <div className="lg-field">
                  <label htmlFor="lg-rep-title">Title{aiMark}</label>
                  {busy ? <div className="lg-skel" /> : (
                    <input
                      id="lg-rep-title"
                      className={cn("lg-input", fresh && "lg-filled")}
                      value={fields.title}
                      onChange={(e) => store.setFields({ title: e.target.value })}
                      placeholder="What went wrong, in one line"
                    />
                  )}
                </div>

                <div className="lg-field">
                  <span className="lbl">Labels</span>
                  <div className="lg-labels">
                    {fields.labels.map((l) => (
                      <span key={l} className="lg-label">
                        {l}
                        <button type="button" className="x" aria-label={`Remove ${l}`} onClick={() => store.setFields({ labels: fields.labels.filter((x) => x !== l) })}>
                          <X />
                        </button>
                      </span>
                    ))}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button type="button" className="lg-label add"><Plus />Add label</button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="max-h-72 min-w-48">
                        <DropdownMenuLabel className="text-xs font-normal text-text-subtle">Add a label</DropdownMenuLabel>
                        {labels === null && <DropdownMenuLabel className="text-xs font-normal">Reading the labels…</DropdownMenuLabel>}
                        {labels?.filter((l) => !fields.labels.includes(l)).map((l) => (
                          <DropdownMenuItem key={l} onSelect={() => store.setFields({ labels: [...fields.labels, l] })}>{l}</DropdownMenuItem>
                        ))}
                        {labels && !labels.some((l) => !fields.labels.includes(l)) && (
                          <DropdownMenuLabel className="text-xs font-normal">{labels.length ? "No more labels" : "Could not read the labels"}</DropdownMenuLabel>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                <ReportTextField id="lg-rep-what" label="What happened" mark={aiMark} busy={busy} fresh={fresh} rows={3}
                  value={fields.what} placeholder="What you were doing and what went wrong" onChange={(what) => store.setFields({ what })} />
                <div className="lg-grid2">
                  <ReportTextField id="lg-rep-steps" label="Steps to reproduce" mark={aiMark} busy={busy} fresh={fresh} rows={4}
                    value={fields.steps} placeholder="1. …" onChange={(steps) => store.setFields({ steps })} />
                  <ReportTextField id="lg-rep-expected" label="Expected" mark={aiMark} busy={busy} fresh={fresh} rows={4}
                    value={fields.expected} placeholder="What should have happened" onChange={(expected) => store.setFields({ expected })} />
                </div>

                <div className="lg-field">
                  <span className="lbl">
                    Log lines <span className="font-normal text-text-subtle">{plural(lines, "line")} from {plural(snippets.length, "place")}</span>
                  </span>
                  <div className="lg-snips">
                    {snippets.map((s) => (
                      <SnippetCard key={s.id} s={s} utc={utc} onContext={(c) => void store.setContext(s.id, c)}
                        onShow={() => showInLogs(s.rows.map((r) => r.entry))} onRemove={() => removeSnippet(s)} />
                    ))}
                  </div>
                  <button
                    type="button"
                    className="lg-addmore"
                    onClick={() => {
                      goTo("logs");
                      toast("Select lines, then choose Add to report");
                    }}
                  >
                    <Plus />Add lines from Logs
                  </button>
                </div>
              </>
            )}
          </div>

          <aside className="lg-rep-side">
            <div className="lg-card">
              <div className="lg-send">
                <div>
                  <div className="lg-meter-l">
                    <span>{over ? "Too long for a link" : "Fits in a GitHub link"}</span>
                    <span>{(fullUrl.length / 1024).toFixed(1)} / {ISSUE_URL_LIMIT / 1024} KB</span>
                  </div>
                  <div className={cn("lg-meter", pct > 85 && "warn")}><i style={{ width: `${pct.toFixed(1)}%` }} /></div>
                </div>
                {!phone && (
                  <>
                    {openButton(over ? "Copy body and open GitHub" : "Open GitHub issue", "w-full")}
                    <Button variant="outline" size="sm" className="w-full" onClick={() => void copyMarkdown()}><Copy />Copy as Markdown</Button>
                  </>
                )}
                <div className="lg-send-note">
                  {over
                    ? "The body is copied for you to paste. The title and labels still go in the link."
                    : `Opens github.com/${LOGS_ISSUE_REPO}/issues/new in your browser, signed in as you. Labels stick only if you can triage that repository.`}
                </div>
                {dupes && (
                  <div className={cn("lg-dupe", dupes.issues.length > 0 && "found")}>
                    {dupes.issues.length ? <TriangleAlert /> : <CheckCircle2 />}
                    <span>
                      {dupes.issues.length ? (
                        <>
                          Open issues that look like this one:
                          <ul>
                            {dupes.issues.slice(0, 3).map((i) => (
                              <li key={i.number}><a href={i.url} target="_blank" rel="noopener noreferrer">#{i.number} {i.title}</a></li>
                            ))}
                          </ul>
                        </>
                      ) : <>No open issue looks like this one. Searched {LOGS_ISSUE_REPO} for “{dupes.query}”.</>}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="lg-card">
              <div className="lg-card-h"><ShieldCheck />Removed before sending<span className="sub">see Preview</span></div>
              <div className="lg-priv">
                <div className="lg-priv-row">
                  <span className="t"><b>Secrets and tokens</b><small>API keys, OAuth tokens, tunnel addresses</small></span>
                  <span className="inline-flex" title="Always removed"><Lock className="lock" /></span>
                </div>
                {PRIVACY_ROWS.map(([key, label, example]) => (
                  <label key={key} className="lg-priv-row">
                    <span className="t"><b>{label}</b><small>{example}</small></span>
                    <Switch checked={priv[key]} onCheckedChange={() => store.togglePriv(key)} />
                  </label>
                ))}
              </div>
            </div>

            <div className="lg-card">
              <div className="lg-card-h"><Info />Environment<span className="sub">untick to leave out</span></div>
              <div className="lg-card-b lg-env">
                {environment === null && <span className="text-xs text-text-subtle">Reading…</span>}
                {environment?.map(([k, v]) => {
                  const on = !envOff.includes(k);
                  return (
                    <label key={k}>
                      <input type="checkbox" className="sr-only" checked={on} onChange={() => store.toggleEnv(k)} />
                      <span className="lg-check" aria-hidden="true" data-on={on}>{on && <Check />}</span>
                      <b>{k}</b>
                      <span className="v">{v}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </aside>
        </div>
      </div>
      {phone && (
        <div className="lg-pfoot">
          <Button variant="outline" className="min-h-11 flex-1" onClick={() => void copyMarkdown()}><Copy />Copy</Button>
          {openButton("Open on GitHub", "min-h-11 flex-1")}
        </div>
      )}
    </>
  );
}

function ReportTextField({ id, label, mark, busy, fresh, rows, value, placeholder, onChange }: {
  id: string;
  label: string;
  mark: ReactNode;
  busy: boolean;
  fresh: boolean;
  rows: number;
  value: string;
  placeholder: string;
  onChange(value: string): void;
}) {
  return (
    <div className="lg-field">
      <label htmlFor={id}>{label}{mark}</label>
      {busy ? <div className="lg-skel tall" /> : (
        <textarea id={id} className={cn("lg-textarea", fresh && "lg-filled")} rows={rows} value={value} placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function SnippetCard({ s, utc, onContext, onShow, onRemove }: {
  s: ReportSnippet;
  utc: boolean;
  onContext(ctx: (typeof SNIPPET_CONTEXTS)[number]): void;
  onShow(): void;
  onRemove(): void;
}) {
  const Icon = SOURCE_ICONS[s.src];
  const first = s.rows[0];
  const last = s.rows[s.rows.length - 1];
  return (
    <div className="lg-snip">
      <div className="lg-snip-h">
        <span className="src"><Icon />{logSourceLabel(s.src)}</span>
        <span className="rng">{first && last ? timeSpan(first.entry.ts, last.lastTs, utc) : ""} · {plural(snippetCount(s), "line")}</span>
        <span className="lg-ctxsel">
          Context
          {SNIPPET_CONTEXTS.map((c) => (
            <button key={c} type="button" aria-pressed={s.ctx === c} onClick={() => onContext(c)}>{c ? `±${c}` : "none"}</button>
          ))}
        </span>
        <span className="end">
          <Button variant="ghost" size="icon-xs" title="Show in Logs" aria-label="Show in Logs" onClick={onShow}><ArrowRight /></Button>
          <Button variant="ghost" size="icon-xs" title="Take out of the report" aria-label="Take out of the report" onClick={onRemove}><X /></Button>
        </span>
      </div>
      <div className="lg-snip-b">
        {snippetLines(s).map((l, i) => <CompactLine key={i} row={l.row} utc={utc} ctx={l.ctx} />)}
      </div>
    </div>
  );
}
