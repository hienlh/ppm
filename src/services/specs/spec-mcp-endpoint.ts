import { createMcpHttpHandler, textResult, type Json } from "../mcp-http-endpoint.ts";
import { specMcpTokens, type SpecMcpBinding } from "./spec-mcp-tokens.ts";
import { SPEC_TOOL_DEFINITIONS } from "./spec-mcp-tools.ts";
import { formatSpecStatus } from "./spec-context.ts";
import { createSpecDrawing } from "./spec-design-link.ts";
import { emitSpecEvent } from "./spec-events.ts";
import { bindSpecSession, specForSession, SpecError, type SpecSessionBinding } from "./spec-store.ts";
import {
  checkSuite, createSpec, getSpec, setDesignSlug, startTask, submitPhase, taskDone, taskGreen, taskRed, type GateResult,
} from "./spec.service.ts";
import { isSpecChecks, isSpecKind, isSpecPhase, isSpecWorkflow } from "../../shared/spec-types.ts";
import {
  SPEC_CREATE_TOOL, SPEC_OPEN_DESIGN_TOOL, SPEC_STATUS_TOOL, SPEC_SUBMIT_TOOL, SUITE_CHECK_TOOL, TASK_DONE_TOOL, TASK_GREEN_TOOL,
  TASK_RED_TOOL, TASK_START_TOOL,
} from "../../shared/spec-tools.ts";
import { ppmToolOffMessage, ppmToolOn } from "../../shared/ppm-tools.ts";
import { configService } from "../config.service.ts";
import { getSessionProjectPath, resolveMigratedSession, sessionIdAliases } from "../db.service.ts";

/**
 * `/api/specs-mcp` — Spec mode's tools for one chat's own agent (plumbing in
 * `mcp-http-endpoint.ts`). The token names the chat; the spec and, for a chat PPM started to run
 * one task, that task come from the chat's binding at each call. Every step goes through
 * `spec.service.ts`, so the agent meets the gates the user's buttons do — and no tool approves.
 */

export interface SpecToolDeps {
  resolveToken: (token: string | null) => SpecMcpBinding | null;
  /** The chat's canonical id (a Codex chat takes its thread's id during its first turn). */
  canonical: (sessionId: string) => string;
  /** Every id the chat has been known by; a binding made before a migration is under the old one. */
  aliases: (sessionId: string) => string[];
  /** The chat's project folder, for `spec_create`. */
  projectPathOf: (sessionId: string) => string | null;
  isOn: (tool: string) => boolean;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const argsOf = (args: unknown): Json => (args && typeof args === "object" && !Array.isArray(args) ? args as Json : {});

function gateText(r: GateResult): Json {
  return textResult(r.message, !r.ok);
}

/** Runs one spec tool for a chat; shared by MCP and `ppm spec call` (which posts to the same endpoint). */
export async function callSpecTool(deps: Pick<SpecToolDeps, "canonical" | "aliases" | "projectPathOf">, sessionId: string, name: string, rawArgs: unknown): Promise<Json> {
  const args = argsOf(rawArgs);
  const binding: SpecSessionBinding | null = specForSession(sessionId)
    ?? deps.aliases(sessionId).map((id) => specForSession(id)).find((b) => b !== null) ?? null;

  if (name === SPEC_CREATE_TOOL) {
    if (binding) return textResult(`This chat already works on spec "${binding.slug}"; finish it, or ask the user to start a new chat for another.`, true);
    const projectPath = deps.projectPathOf(sessionId) ?? deps.projectPathOf(deps.canonical(sessionId));
    if (!projectPath) return textResult("This chat has no project folder, so it cannot hold a spec.", true);
    const title = str(args.title);
    if (!title) return textResult("A spec needs a title.", true);
    const v = await createSpec(projectPath, {
      title,
      kind: isSpecKind(args.kind) ? args.kind : undefined,
      workflow: isSpecWorkflow(args.workflow) ? args.workflow : undefined,
      checks: isSpecChecks(args.checks) ? args.checks : undefined,
      sessionId: deps.canonical(sessionId),
    });
    if (deps.canonical(sessionId) !== sessionId) bindSpecSession(sessionId, { projectPath, slug: v.slug });
    const first = v.phases[v.order[0]!];
    return textResult(`Spec "${v.title}" started in ${v.folder}/ (${v.kind}, checks: ${v.checks}). Next: write ${first.file} — the template is already there.`);
  }

  if (!binding) {
    return textResult("This chat is not in Spec mode. Start a spec with spec_create when the user asks for one.", true);
  }
  const { projectPath, slug, taskId } = binding;
  const taskArg = str(args.task);
  const ownTask = (): string | Json => {
    const id = taskArg ?? taskId;
    if (!id) return textResult("Name the task: {\"task\": \"<number>\"}.", true);
    if (taskId && id !== taskId) return textResult(`This chat runs task ${taskId} only; task ${id} belongs to another chat.`, true);
    return id;
  };

  switch (name) {
    case SPEC_STATUS_TOOL:
      return textResult(formatSpecStatus(await getSpec(projectPath, slug)));
    case SPEC_SUBMIT_TOOL: {
      if (taskId) return textResult("A task chat does not submit documents; the spec's own chat does.", true);
      if (!isSpecPhase(args.phase)) return textResult('phase must be "requirements", "design" or "tasks".', true);
      const r = await submitPhase(projectPath, slug, args.phase);
      if (r.ok && r.autoApproved) return textResult(`${args.phase} approved (Quick spec). Continue with the next document.`);
      return gateText(r);
    }
    case SPEC_OPEN_DESIGN_TOOL: {
      if (taskId) return textResult("A task chat does not open the drawing; the spec's own chat does.", true);
      let v = await getSpec(projectPath, slug);
      if (!v.needsDrawing) return textResult('The requirements do not say "UI: yes", so this spec has no drawing.', true);
      if (!v.designSlug) v = await setDesignSlug(projectPath, slug, await createSpecDrawing(projectPath, v.title));
      emitSpecEvent({ type: "spec:open-design", projectPath, slug, designSlug: v.designSlug! });
      return textResult(`The drawing is designs/${v.designSlug}/ and is open in PPM for the user. Draw the screens in designs/${v.designSlug}/index.html as one self-contained page (no network requests). When it is ready, tell the user: they approve the drawing in the Spec pane, and design.md waits for that.`);
    }
    case TASK_START_TOOL: {
      const id = ownTask();
      if (typeof id !== "string") return id;
      // A task chat was started by PPM's scheduler, which already started its task.
      if (taskId) {
        const v = await getSpec(projectPath, slug);
        const t = v.tasks.find((x) => x.id === id);
        if (t && (t.status === "running" || t.status === "red")) return textResult(`Task ${id} is already started for this chat; next: ${t.next}.`);
      }
      return gateText(await startTask(projectPath, slug, id, { sessionId: deps.canonical(sessionId) }));
    }
    case TASK_DONE_TOOL: {
      const id = ownTask();
      if (typeof id !== "string") return id;
      return gateText(await taskDone(projectPath, slug, id, str(args.summary) ?? ""));
    }
    case TASK_RED_TOOL: {
      const id = ownTask();
      if (typeof id !== "string") return id;
      return gateText(await taskRed(projectPath, slug, id));
    }
    case TASK_GREEN_TOOL: {
      const id = ownTask();
      if (typeof id !== "string") return id;
      return gateText(await taskGreen(projectPath, slug, id));
    }
    case SUITE_CHECK_TOOL: {
      const r = await checkSuite(projectPath, slug);
      return textResult(r.message, !r.ok);
    }
    default:
      return textResult(`Unknown tool ${name}`, true);
  }
}

export function createSpecMcpHandler(deps: SpecToolDeps) {
  return createMcpHttpHandler<SpecMcpBinding>({
    serverName: "ppm-specs",
    tokenRequired: "A chat session token is required",
    resolveToken: deps.resolveToken,
    tools: SPEC_TOOL_DEFINITIONS as unknown as Json[],
    unavailable: (name) => (deps.isOn(name) ? null : ppmToolOffMessage(name)),
    callTool: async (binding, name, args) => {
      try {
        return await callSpecTool(deps, binding.sessionId, name, args);
      } catch (e) {
        if (e instanceof SpecError) return textResult(e.message, true);
        throw e;
      }
    },
  });
}

export const specMcpHandler = createSpecMcpHandler({
  resolveToken: (token) => specMcpTokens.resolve(token),
  canonical: resolveMigratedSession,
  aliases: sessionIdAliases,
  projectPathOf: getSessionProjectPath,
  isOn: (tool) => ppmToolOn(configService.get("ai"), tool as never),
});
