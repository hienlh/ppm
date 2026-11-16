/**
 * Live state of PR links (`owner/repo#n`) through the host's own `gh` login, so private repositories
 * work with nobody's token in PPM: one `gh api graphql` per up to 20 PRs, each PR an alias. Owner,
 * repo and number go in as GraphQL variables, never into the query text. No `gh`, or `gh` not signed
 * in, reads as "unknown · gh not available" for every link (plan decision 9) and never throws.
 */
import { parsePrRef } from "../../../shared/ppm-tasks-refs.ts";
import { ghFailure, runGh, type GhRunner } from "./gh-cli-runner.ts";

export const PR_BATCH = 20;
const FAILING_NAMES = 3;

export interface PrChecks { total: number; failing: number; pending: number; failingNames: string[] }

export interface PrLinkState {
  state: "open" | "merged" | "closed" | "draft";
  checks: PrChecks;
  reviewDecision: string | null;
  unresolvedThreads: number;
  author: string | null;
  title: string;
}

/** One link's answer: a state, or why there is none. */
export type ReadResult = { state: Record<string, unknown>; error: null } | { state: null; error: string };

const PR_FIELDS = `state isDraft title author { login } reviewDecision
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion }
    ... on StatusContext { context state }
  } } } } } }`;

/** The query and its variables for one batch; exported for the tests. */
export function buildPrQuery(refs: ReadonlyArray<{ owner: string; repo: string; number: number }>): { query: string; args: string[] } {
  const params: string[] = [];
  const body: string[] = [];
  const args: string[] = [];
  refs.forEach((r, i) => {
    params.push(`$o${i}: String!`, `$r${i}: String!`, `$n${i}: Int!`);
    body.push(`p${i}: repository(owner: $o${i}, name: $r${i}) { pullRequest(number: $n${i}) { ${PR_FIELDS} } }`);
    args.push("-f", `o${i}=${r.owner}`, "-f", `r${i}=${r.repo}`, "-F", `n${i}=${r.number}`);
  });
  const query = `query(${params.join(", ")}) { ${body.join("\n")} }`;
  return { query, args: ["api", "graphql", "-f", `query=${query}`, ...args] };
}

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILED_STATUSES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATUSES = new Set(["PENDING", "EXPECTED"]);

type Ctx = { __typename?: string; name?: string; status?: string; conclusion?: string | null; context?: string; state?: string };

function checksOf(contexts: Ctx[]): PrChecks {
  const out: PrChecks = { total: 0, failing: 0, pending: 0, failingNames: [] };
  for (const c of contexts) {
    out.total++;
    const name = String(c.name ?? c.context ?? "check");
    let failed = false;
    if (c.__typename === "CheckRun") {
      if (c.status !== "COMPLETED") out.pending++;
      else failed = FAILED_CONCLUSIONS.has(String(c.conclusion ?? ""));
    } else {
      if (PENDING_STATUSES.has(String(c.state ?? ""))) out.pending++;
      else failed = FAILED_STATUSES.has(String(c.state ?? ""));
    }
    if (failed) {
      out.failing++;
      if (out.failingNames.length < FAILING_NAMES) out.failingNames.push(name.slice(0, 120));
    }
  }
  return out;
}

/** Maps one `pullRequest` node; null when GitHub answered none (no such PR, or no access). */
export function mapPullRequest(pr: unknown): PrLinkState | null {
  if (!pr || typeof pr !== "object") return null;
  const p = pr as Record<string, any>;
  const raw = String(p.state ?? "").toUpperCase();
  const state: PrLinkState["state"] = raw === "MERGED" ? "merged" : raw === "CLOSED" ? "closed" : p.isDraft ? "draft" : "open";
  const threads: Array<{ isResolved?: boolean }> = p.reviewThreads?.nodes ?? [];
  const contexts: Ctx[] = p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return {
    state,
    checks: checksOf(contexts),
    reviewDecision: typeof p.reviewDecision === "string" ? p.reviewDecision : null,
    unresolvedThreads: threads.filter((t) => t && t.isResolved === false).length,
    author: typeof p.author?.login === "string" ? p.author.login : null,
    title: String(p.title ?? "").slice(0, 300),
  };
}

/** States of these PR refs, keyed by ref. Refs that are not a PR read as an error. */
export async function readPrStates(refs: readonly string[], gh: GhRunner = runGh): Promise<Map<string, ReadResult>> {
  const out = new Map<string, ReadResult>();
  const parsed: Array<{ ref: string; owner: string; repo: string; number: number }> = [];
  for (const ref of refs) {
    const pr = parsePrRef(ref);
    if (pr) parsed.push({ ref, ...pr });
    else out.set(ref, { state: null, error: "not a PR reference" });
  }
  for (let i = 0; i < parsed.length; i += PR_BATCH) {
    const batch = parsed.slice(i, i + PR_BATCH);
    const run = await gh(buildPrQuery(batch).args);
    let data: Record<string, any> | null = null;
    if (run.code === 0 || run.stdout.trim().startsWith("{")) {
      try { data = (JSON.parse(run.stdout) as { data?: Record<string, any> }).data ?? null; } catch { data = null; }
    }
    if (!data) {
      const failure = ghFailure(run);
      for (const b of batch) out.set(b.ref, { state: null, error: failure.message });
      continue;
    }
    batch.forEach((b, j) => {
      const mapped = mapPullRequest(data![`p${j}`]?.pullRequest);
      out.set(b.ref, mapped ? { state: mapped as unknown as Record<string, unknown>, error: null } : { state: null, error: "PR not found or no access" });
    });
  }
  return out;
}
