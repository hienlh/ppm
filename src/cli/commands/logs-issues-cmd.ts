import type { Command } from "commander";
import { rawLogLine } from "../../shared/logs-model.ts";
import { LOGS_ISSUE_REPO, type LogIssue, type LogIssuesResult, type LogIssuesSummary, type ReportDraft } from "../../shared/logs-api.ts";
import { serverRequest, ServerDownError, type ServerRequestOptions } from "../utils/ppm-server-client.ts";
import { C, fail, run } from "./chat-cmd-request.ts";
import { printTable } from "./cli-table.ts";

/**
 * `ppm logs issues` and `ppm logs report draft`: the Logs window's Issues tab and its report
 * draft, through `/api/logs` on the running PPM. Sorting errors into issues, Auto and the dismissed
 * list are the server's (it asks Claude Haiku on the person's own account), so with no PPM running
 * these commands stop rather than run any of it here. A draft is printed; posting it to GitHub
 * stays with the person.
 */

const ANALYZE_WAIT_MS = 5 * 60_000;
const POLL_MS = 1500;

async function logsApi<T>(method: string, path: string, body?: unknown, opts: ServerRequestOptions = {}): Promise<T> {
  try {
    return await serverRequest<T>(method, `/logs${path}`, body, opts);
  } catch (e) {
    if (e instanceof ServerDownError) {
      throw new Error("The Logs window's issues live in the running PPM. Start PPM (`ppm start`) and run this again.");
    }
    throw e;
  }
}

const when = (ts: number | null) => (ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 19) : "never");

function printIssues(result: LogIssuesResult, all: boolean): void {
  const shown = result.issues.filter((i) => all || !i.dismissed);
  if (!shown.length) console.log(`${C.dim}No issues${all ? "" : " (dismissed ones are hidden; --dismissed shows them)"}.${C.reset}`);
  else {
    printTable(["ID", "Kind", "Area", "Title", "Count", "Last"], shown.map((i) => [
      i.id, i.dismissed ? `${i.cls} (dismissed)` : i.cls, i.area, i.title, String(i.count), when(i.last),
    ]));
  }
  console.log(`${C.dim}Sorted ${when(result.analyzedAt)} by ${result.model} · ${result.unsorted} unsorted · auto ${result.auto ? "on" : "off"}${result.running ? " · sorting now" : ""}${C.reset}`);
  if (result.error) console.log(`${C.yellow}!${C.reset} The last sort failed: ${result.error}`);
}

/** Waits for a sort to end, then answers the issues as they stand. */
async function waitForSort(): Promise<LogIssuesResult> {
  const deadline = Date.now() + ANALYZE_WAIT_MS;
  while (Date.now() < deadline) {
    const summary = await logsApi<LogIssuesSummary>("GET", "/issues/summary");
    if (!summary.running) return logsApi<LogIssuesResult>("GET", "/issues");
    await Bun.sleep(POLL_MS);
  }
  return fail("The sort is still running; check later with `ppm logs issues`.");
}

/** Each issue's newest lines as one report snippet, as the Logs window adds them. */
export function issueSnippets(issues: readonly LogIssue[], ids: readonly string[]): Array<{ label: string; lines: string[] }> {
  return ids.map((id) => {
    const issue = issues.find((i) => i.id === id);
    if (!issue) throw new Error(`No issue ${id}; \`ppm logs issues --dismissed\` lists them`);
    return { label: `${issue.area}: ${issue.title}`, lines: issue.lines.map((e) => rawLogLine(e)) };
  });
}

export function registerLogsSubcommands(logs: Command): void {
  const issues = logs
    .command("issues")
    .description("The errors and warnings of the last 24 hours, sorted into issues by AI (as the Logs window shows them)")
    .option("--dismissed", "Include dismissed issues")
    .option("--json", "Print JSON")
    .action((opts: { dismissed?: boolean; json?: boolean }) => run(async () => {
      const result = await logsApi<LogIssuesResult>("GET", "/issues");
      if (opts.json) return void console.log(JSON.stringify(result, null, 2));
      printIssues(result, !!opts.dismissed);
    })());

  issues
    .command("analyze")
    .description("Sort the errors and warnings no issue covers yet, and wait for the result")
    .option("--full", "Sort every pattern in the window again from scratch")
    .action((opts: { full?: boolean }) => run(async () => {
      await logsApi("POST", "/issues/analyze", { full: !!opts.full });
      console.log(`${C.dim}Sorting...${C.reset}`);
      printIssues(await waitForSort(), false);
    })());

  issues
    .command("auto <state>")
    .description("Turn automatic sorting on or off")
    .action((state: string) => run(async () => {
      if (state !== "on" && state !== "off") fail("Use on or off");
      await logsApi("POST", "/issues/auto", { on: state === "on" });
      console.log(`${C.green}✓${C.reset} Automatic sorting ${state}`);
    })());

  issues
    .command("dismiss <id>")
    .description("Hide an issue; a later sort keeps it hidden")
    .action((id: string) => run(async () => {
      await logsApi("POST", `/issues/${encodeURIComponent(id)}/dismiss`);
      console.log(`${C.green}✓${C.reset} Issue ${id} dismissed`);
    })());

  issues
    .command("undismiss [id]")
    .description("Bring a dismissed issue back, or every one with --all")
    .option("--all", "Bring back every dismissed issue")
    .action((id: string | undefined, opts: { all?: boolean }) => run(async () => {
      if (!!id === !!opts.all) fail("Name one issue, or pass --all");
      if (opts.all) await logsApi("POST", "/issues/undismiss-all");
      else await logsApi("POST", `/issues/${encodeURIComponent(id!)}/undismiss`);
      console.log(`${C.green}✓${C.reset} ${opts.all ? "Every dismissed issue is" : `Issue ${id} is`} back`);
    })());

  const reportCmd = logs.command("report").description("Draft a bug report from issues");
  reportCmd
    .command("draft <ids...>")
    .description("Draft a GitHub bug report from issues' lines with AI, and print it (nothing is posted)")
    .option("--note <text>", "What you saw, for the draft to use")
    .option("--json", "Print JSON")
    .action((ids: string[], opts: { note?: string; json?: boolean }) => run(async () => {
      const { issues: known } = await logsApi<LogIssuesResult>("GET", "/issues");
      const snippets = issueSnippets(known, ids);
      const environment = await logsApi<Array<[string, string]>>("GET", "/environment");
      const draft = await logsApi<ReportDraft>("POST", "/report/draft", { snippets, environment, ...(opts.note && { note: opts.note }) }, { timeoutMs: 120_000, progress: true });
      if (opts.json) return void console.log(JSON.stringify(draft, null, 2));
      console.log([`Title: ${draft.title}`, `Labels: ${draft.labels.join(", ") || "—"}`, "", "What happened:", draft.what, "",
        "Steps:", draft.steps, "", "Expected:", draft.expected].join("\n"));
      console.log(`${C.dim}Drafted by ${draft.model}. Nothing was posted; open the report yourself at https://github.com/${LOGS_ISSUE_REPO}/issues/new${C.reset}`);
    })());
}
