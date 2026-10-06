/**
 * The bug report being put together in the Report tab. In memory and outside the component, so
 * a report survives switching tabs, closing the Logs window and opening it again — but not a
 * reload, since it holds log lines.
 */
import { create } from "zustand";
import type { LogRow } from "@/lib/logs/logs-view-model";
import {
  snippetCount, snippetHeading, snippetRawLines, snippetSource, type ReportFields, type ReportSnippet, type SnippetContext,
} from "@/lib/logs/logs-report";
import type { LogEntry } from "../../../shared/logs-model";
import { userAgentSummary } from "../../../shared/user-agent-label";
import { draftReport, fetchAround, fetchEnvironment } from "./logs-client";

export type DraftStatus = "none" | "drafting" | "done";

export interface PrivacySwitches {
  home: boolean;
  email: boolean;
  chats: boolean;
  projects: boolean;
}

interface LogsReportState {
  snippets: ReportSnippet[];
  fields: ReportFields;
  status: DraftStatus;
  /** Lines changed after Claude wrote the draft. */
  stale: boolean;
  /** The fields Claude just filled, tinted for a moment. */
  fresh: boolean;
  error: string | null;
  model: string | null;
  /** Lines the draft was written from. */
  basis: number;
  view: "write" | "preview";
  /** Environment rows left out, by name. */
  envOff: string[];
  priv: PrivacySwitches;

  /** False when the same lines are already in the report. */
  add(rows: LogRow[]): boolean;
  remove(id: string): { snippet: ReportSnippet; index: number } | null;
  restore(snippet: ReportSnippet, index: number): void;
  setContext(id: string, ctx: SnippetContext): Promise<void>;
  setFields(patch: Partial<ReportFields>): void;
  setView(view: "write" | "preview"): void;
  toggleEnv(name: string): void;
  togglePriv(key: keyof PrivacySwitches): void;
  /** Has AI write the fields from the lines and the environment rows left in. */
  draft(): Promise<void>;
}

let environmentRead: Promise<Array<[string, string]>> | null = null;

/** The environment rows a report offers: the server's, then this browser. Read once per page load. */
export function loadReportEnvironment(): Promise<Array<[string, string]>> {
  environmentRead ??= fetchEnvironment()
    .then((rows) => [...rows, ["Browser", userAgentSummary(navigator.userAgent)] as [string, string]])
    .catch((e: unknown) => {
      environmentRead = null;
      throw e;
    });
  return environmentRead;
}

let seq = 0;
const EMPTY_FIELDS: ReportFields = { title: "", labels: [], what: "", steps: "", expected: "" };

const sameIds = (a: readonly LogRow[], b: readonly LogRow[]) =>
  a.length === b.length && a.every((r, i) => r.key === b[i]!.key && r.count === b[i]!.count);

export const useLogsReportStore = create<LogsReportState>((set, get) => ({
  snippets: [],
  fields: EMPTY_FIELDS,
  status: "none",
  stale: false,
  fresh: false,
  error: null,
  model: null,
  basis: 0,
  view: "write",
  envOff: [],
  priv: { home: true, email: true, chats: true, projects: false },

  add: (rows) => {
    if (!rows.length || get().snippets.some((s) => sameIds(s.rows, rows))) return false;
    const entries: LogEntry[] = rows.map((r) => r.entry);
    const snippet: ReportSnippet = { id: `s${++seq}`, src: snippetSource(entries), rows, ctx: 0, around: null };
    set((s) => ({ snippets: [...s.snippets, snippet], stale: s.status === "done" }));
    return true;
  },

  remove: (id) => {
    const index = get().snippets.findIndex((s) => s.id === id);
    if (index < 0) return null;
    const snippet = get().snippets[index]!;
    set((s) => ({ snippets: s.snippets.filter((x) => x.id !== id), stale: s.status === "done" }));
    return { snippet, index };
  },

  restore: (snippet, index) => {
    set((s) => {
      const next = s.snippets.slice();
      next.splice(Math.min(index, next.length), 0, snippet);
      return { snippets: next };
    });
  },

  setContext: async (id, ctx) => {
    set((s) => ({ snippets: s.snippets.map((x) => (x.id === id ? { ...x, ctx } : x)) }));
    const snippet = get().snippets.find((x) => x.id === id);
    if (!ctx || !snippet || snippet.around) return;
    const ids = snippet.rows.flatMap((r) => r.ids);
    try {
      const around = await fetchAround([ids[0]!, ids[ids.length - 1]!], 20, snippet.src);
      set((s) => ({ snippets: s.snippets.map((x) => (x.id === id ? { ...x, around } : x)) }));
    } catch {
      // Without the lines around, the snippet is just the picked lines.
    }
  },

  setFields: (patch) => set((s) => ({ fields: { ...s.fields, ...patch } })),
  setView: (view) => set({ view }),
  toggleEnv: (name) => set((s) => ({ envOff: s.envOff.includes(name) ? s.envOff.filter((n) => n !== name) : [...s.envOff, name] })),
  togglePriv: (key) => set((s) => ({ priv: { ...s.priv, [key]: !s.priv[key] } })),

  draft: async () => {
    const { snippets, status } = get();
    if (!snippets.length || status === "drafting") return;
    set({ status: "drafting", view: "write", error: null });
    try {
      const rows = await loadReportEnvironment().catch(() => [] as Array<[string, string]>);
      const environment = rows.filter(([name]) => !get().envOff.includes(name));
      const d = await draftReport({
        snippets: snippets.map((s) => ({ label: snippetHeading(s), lines: snippetRawLines(s) })),
        environment,
      });
      set({
        status: "done",
        fields: { title: d.title, labels: d.labels, what: d.what, steps: d.steps, expected: d.expected },
        model: d.model,
        basis: snippets.reduce((a, s) => a + snippetCount(s), 0),
        stale: false,
        fresh: true,
      });
      setTimeout(() => set({ fresh: false }), 900);
    } catch (e) {
      // What was there before stays: a failed draft must not wipe what the person wrote.
      set((s) => ({ status: s.model ? "done" : "none", error: e instanceof Error ? e.message : String(e) }));
    }
  },
}));
