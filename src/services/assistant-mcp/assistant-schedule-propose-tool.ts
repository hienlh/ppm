/**
 * `schedule_propose_script`: the PPM Assistant proposes a script schedule in a registered project.
 * The same proposal rules and the same card as a chat's `session_schedule_propose_script`
 * (`src/services/schedule-proposals/`), asked through `ctx.ask` — so a watch turn, which refuses
 * every ask, creates nothing — and saved through `POST /api/schedules` like `schedule_save`.
 * The card is allowed only in PPM (`reviewInPpm`), never from Telegram.
 */
import type { Schedule } from "../../types/scheduler.ts";
import type { Json } from "../mcp-http-endpoint.ts";
import { getSchedule } from "../scheduler-db.service.ts";
import { SCHEDULE_PROPOSE_SCRIPT_TOOL } from "../../shared/assistant-schedule-tool-names.ts";
import { resolveAssistantProject } from "./assistant-project-scope.ts";
import { errorResult, jsonResult, notApprovedResult } from "./assistant-tool-output.ts";
import type { ToolContext } from "./assistant-tool-family.ts";
import { defaultProviderOf, registeredProjects, schedulePath, scheduleView, timeZoneOf, type ScheduleDeps } from "./assistant-schedule-shape.ts";
import { parseScriptProposal, proposalMismatch, proposalRouteBody } from "../schedule-proposals/script-proposal.ts";
import { scriptProposalSummary, type ProposalCardDeps } from "../schedule-proposals/script-proposal-card.ts";
import { liveProposalCardDeps, proposalStaleReason } from "../schedule-proposals/script-proposal-create.ts";

export interface ProposeScriptDeps extends ScheduleDeps {
  card?: () => ProposalCardDeps;
}

export async function scheduleProposeScript(ctx: ToolContext, args: Record<string, unknown>, deps: ProposeScriptDeps = {}): Promise<Json> {
  const projects = registeredProjects(deps);
  if (args.project === undefined) return errorResult("`project` is required: the registered project whose folder the script runs in.");
  const project = resolveAssistantProject(args.project, () => projects);
  if (!project.ok) return errorResult(project.error);
  const { project: _project, ...rest } = args;
  const provider = defaultProviderOf(deps);
  const parsed = parseScriptProposal(rest, { name: project.value.name, path: project.value.path }, provider,
    projects.map((p) => p.path), "a registered project's folder");
  if (!parsed.ok) return errorResult(parsed.error);
  const proposal = parsed.proposal;

  const summary = scriptProposalSummary(proposal, provider, (deps.card ?? liveProposalCardDeps)());
  const input = { project: proposal.project.name, name: proposal.name, ...(proposal.file ? { file: proposal.file.path, sha256: proposal.file.sha256 } : {}) };
  const verdict = await ctx.ask({ tool: SCHEDULE_PROPOSE_SCRIPT_TOOL, input, summary });
  if (verdict.verdict !== "approved") return notApprovedResult(SCHEDULE_PROPOSE_SCRIPT_TOOL, verdict, input);

  const stale = proposalStaleReason(proposal, provider, defaultProviderOf(deps));
  if (stale) {
    return errorResult(JSON.stringify({ outcome: "stale", action: SCHEDULE_PROPOSE_SCRIPT_TOOL, reason: stale, note: "Nothing was created. Propose it again only if it is still what the user wants." }, null, 1));
  }
  const res = await ctx.callRoute<Schedule>("POST", "/api/schedules", proposalRouteBody(proposal));
  if (!res.ok || !res.data) return errorResult(`Not created: ${res.error ?? `the route answered ${res.status}`}`);
  // The route answers a view (inputs parsed, no secrets); the stored row is what runs, so that is compared.
  const stored = getSchedule(res.data.id);
  const mismatch = stored ? proposalMismatch(stored, proposal, provider) : "schedule itself";
  if (mismatch) {
    await ctx.callRoute("DELETE", schedulePath(res.data.id));
    return errorResult(`Not created: the stored ${mismatch} differed from what the card showed, so it was removed again.`);
  }
  return jsonResult({
    created: true,
    schedule: { ...scheduleView(res.data, project.value, timeZoneOf(deps)), prompt: undefined, mode: res.data.mode },
    note: "The user allowed it. It runs at its next fire; schedule_get reads its runs, and schedule_save with enabled: false pauses it.",
  });
}
