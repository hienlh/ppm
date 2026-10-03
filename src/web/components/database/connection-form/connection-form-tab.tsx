/**
 * The `db-connection` tab: DBGate's New Connection screen, for a new connection or a saved one.
 *
 * A centred column under a row of sub-tabs, with Connect · Test · Save pinned to the bottom and
 * the result beside them — on a phone, above them, where a thumb reaches. Nothing is saved until
 * Connect has connected or Save is pressed; either closes the tab and shows the connection in
 * the tree.
 */
import { useRef } from "react";
import { Loader2, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useTabStore } from "@/stores/tab-store";
import { DB_TYPE_LABELS } from "../../../../shared/db-types";
import { FORM_TAB_LABELS, successDetail, successDetails, tabsFor, type FormTab } from "./connection-form-state";
import { useConnectionForm } from "./use-connection-form";
import { ConnectionGeneralPane } from "./connection-general-pane";
import { ConnectionSshPane } from "./connection-ssh-pane";
import { ConnectionSslPane } from "./connection-ssl-pane";
import { ConnectionAdvancedPane } from "./connection-advanced-pane";
import { ConnectionTestResult } from "./connection-test-result";

const footerButton =
  "inline-flex items-center justify-center gap-1.5 h-11 md:h-8 flex-1 md:flex-none rounded-[10px] md:rounded-md px-3.5 text-[14px] md:text-[12.5px] font-medium disabled:opacity-50 disabled:cursor-not-allowed";

export function ConnectionFormTab({ metadata, tabId }: { metadata?: Record<string, unknown>; tabId?: string }) {
  const connectionId = typeof metadata?.connectionId === "number" ? metadata.connectionId : null;
  const form = useConnectionForm(connectionId, tabId);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<FormTab, HTMLButtonElement | null>>>({});
  const tabs = tabsFor(form.values.type);
  const savedName = typeof metadata?.connectionName === "string" ? metadata.connectionName : "connection";
  const title = connectionId === null ? "New connection" : `Edit ${savedName}`;
  const close = () => { if (tabId) useTabStore.getState().closeTab(tabId); };

  const openTab = (t: FormTab) => {
    form.setTab(t);
    bodyRef.current?.scrollTo({ top: 0 });
  };
  const onTabKey = (e: React.KeyboardEvent, from: FormTab) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = tabs[(tabs.indexOf(from) + step + tabs.length) % tabs.length]!;
    openTab(next);
    tabRefs.current[next]?.focus();
  };

  const header = (
    <header className="md:hidden flex h-[52px] shrink-0 items-center gap-1.5 border-b border-border-soft bg-panel-2 pl-1 pr-3">
      <button type="button" onClick={close} aria-label="Close" className="grid size-11 place-items-center rounded-md text-text-2">
        <X className="size-5" />
      </button>
      <div className="min-w-0">
        <b className="block truncate text-[15px] text-text-primary">{title}</b>
        <small className="block text-xs text-text-subtle">{DB_TYPE_LABELS[form.values.type]}</small>
      </div>
    </header>
  );

  if (form.load.kind !== "ready") {
    return (
      <div className="flex h-full flex-col bg-background">
        {header}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-text-2">
          {form.load.kind === "loading" ? (
            <><Loader2 className="size-5 animate-spin text-text-subtle" />Loading the connection…</>
          ) : (
            <>
              <p>Could not open the connection: {form.load.message}</p>
              <button type="button" onClick={form.reload} className={cn(footerButton, "flex-none border border-border bg-surface text-text-primary")}>Try again</button>
            </>
          )}
        </div>
      </div>
    );
  }

  const run = form.run;
  const busy = run.kind === "running";
  const testing = busy && run.action === "test";
  const connecting = busy && run.action === "connect";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="db-connection-tab">
      {header}
      <div className="shrink-0 border-b border-border bg-panel px-1 md:px-5">
        <div role="tablist" aria-label="Connection settings" className="mx-auto flex w-full max-w-[760px] gap-0.5 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t}
              ref={(el) => { tabRefs.current[t] = el; }}
              type="button"
              role="tab"
              id={`cft-${t}`}
              aria-controls={`cfp-${t}`}
              aria-selected={form.tab === t}
              tabIndex={form.tab === t ? 0 : -1}
              onClick={() => openTab(t)}
              onKeyDown={(e) => onTabKey(e, t)}
              className={cn(
                "h-11 md:h-[38px] shrink-0 whitespace-nowrap px-3.5 md:px-3 text-[13.5px] md:text-[12.5px]",
                form.tab === t
                  ? "font-semibold text-text-primary shadow-[inset_0_-2px_0_var(--color-primary)]"
                  : "text-text-2 can-hover:hover:text-text-primary",
              )}
            >
              {FORM_TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <div ref={bodyRef} className="@container min-h-0 flex-1 overflow-auto px-4 pb-5 pt-4 md:px-5 md:pb-7 md:pt-[18px] md:[scrollbar-gutter:stable_both-edges]">
        <div id={`cfp-${form.tab}`} role="tabpanel" aria-labelledby={`cft-${form.tab}`} className="mx-auto w-full max-w-[760px]">
          {form.tab === "general" && <ConnectionGeneralPane form={form} />}
          {form.tab === "ssh" && <ConnectionSshPane form={form} />}
          {form.tab === "ssl" && <ConnectionSslPane form={form} />}
          {form.tab === "advanced" && <ConnectionAdvancedPane form={form} />}
        </div>
      </div>

      <footer className="shrink-0 border-t border-border bg-panel px-3 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom))] md:px-5 md:py-2.5">
        <div className="mx-auto flex w-full max-w-[760px] flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={form.connect}
            disabled={busy}
            className={cn(footerButton, "flex-[2] md:flex-none bg-primary text-primary-foreground can-hover:hover:bg-primary/90")}
          >
            {connecting && <Loader2 className="size-4 animate-spin" />}
            {connecting ? "Connecting…" : "Connect"}
          </button>
          <button
            type="button"
            onClick={form.test}
            disabled={busy && !testing}
            className={cn(footerButton, "border border-border bg-surface text-text-primary can-hover:hover:bg-surface-hover")}
          >
            {testing ? "Cancel test" : "Test"}
          </button>
          <button
            type="button"
            onClick={form.save}
            disabled={busy}
            className={cn(footerButton, "border border-border bg-surface text-text-primary can-hover:hover:bg-surface-hover")}
          >
            Save
          </button>
          <ConnectionTestResult
            run={run}
            successDetail={run.kind === "ok" ? successDetail(run.result, form.values, form.ctx) : ""}
            successDetails={run.kind === "ok" ? successDetails(run.result, form.values, form.ctx) : ""}
            detailsOpen={form.detailsOpen}
            onToggleDetails={form.toggleDetails}
          />
        </div>
      </footer>
    </div>
  );
}
