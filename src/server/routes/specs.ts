import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { designFail as fail, designJsonBody as jsonBody, type DesignRouteEnv } from "./design-route-helpers.ts";
import {
  approvePhase, attachSession, checkSuite, createSpec, getSpec, listSpecs, requestChanges, resetTask,
  setChecks, startTask, submitPhase, taskDone, taskGreen, taskRed,
} from "../../services/specs/spec.service.ts";
import { isSpecChecks, isSpecKind, isSpecPhase, isSpecWorkflow, phaseFileName, type SpecPhase } from "../../shared/spec-types.ts";
import { startRun, stopRun } from "../../services/specs/spec-scheduler.ts";
import { tellSpecChat } from "../ws/spec-run-env.ts";
import { resolve } from "node:path";
import { getSessionProvider, sessionIdAliases } from "../../services/db.service.ts";
import { specForSession } from "../../services/specs/spec-store.ts";
import { providerRegistry } from "../../providers/registry.ts";

/**
 * `/api/project/:projectName/specs` — the specs of one project, for the browser and `ppm spec`.
 *
 * Approving a phase is here and nowhere else: the AI's tools (`/api/specs-mcp`) can submit a
 * phase for review but never approve one, and this router sits behind PPM's own auth.
 * A gate that says no answers 409 with the reason, which the UI shows as is.
 */
export const specRoutes = new Hono<DesignRouteEnv>();

const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

function gate(c: Parameters<typeof fail>[0], r: { ok: boolean; message: string; view: unknown }) {
  return r.ok ? c.json(ok({ message: r.message, spec: r.view })) : c.json(err(r.message), 409);
}

specRoutes.get("/", async (c) => {
  try {
    return c.json(ok(await listSpecs(c.get("projectPath"))));
  } catch (e) {
    return fail(c, e);
  }
});

specRoutes.post("/", async (c) => {
  const body = await jsonBody(c);
  const title = str(body?.title, 120);
  if (!body || !title) return c.json(err("A spec needs a title"), 400);
  try {
    const spec = await createSpec(c.get("projectPath"), {
      title,
      slug: str(body.slug, 63),
      kind: isSpecKind(body.kind) ? body.kind : undefined,
      workflow: isSpecWorkflow(body.workflow) ? body.workflow : undefined,
      checks: isSpecChecks(body.checks) ? body.checks : undefined,
      sessionId: str(body.sessionId),
    });
    return c.json(ok(spec), 201);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * Which spec of this project a chat drives (or runs a task of), by any id the chat has had, and
 * the chat's provider: a spec names its chats by id only, and a tab opened without the provider
 * would show the chat as Claude's.
 */
specRoutes.get("/by-session/:sessionId", async (c) => {
  const projectPath = c.get("projectPath");
  const sessionId = c.req.param("sessionId");
  const binding = sessionIdAliases(sessionId).map((id) => specForSession(id)).find((b) => b !== null) ?? null;
  if (!binding || resolve(binding.projectPath) !== resolve(projectPath)) return c.json(ok(null));
  return c.json(ok({ slug: binding.slug, taskId: binding.taskId ?? null, providerId: getSessionProvider(sessionId) }));
});

specRoutes.get("/:slug", async (c) => {
  try {
    return c.json(ok(await getSpec(c.get("projectPath"), c.req.param("slug"))));
  } catch (e) {
    return fail(c, e);
  }
});

specRoutes.put("/:slug/checks", async (c) => {
  const body = await jsonBody(c);
  if (!isSpecChecks(body?.checks)) return c.json(err("checks must be standard or thorough"), 400);
  try {
    return c.json(ok(await setChecks(c.get("projectPath"), c.req.param("slug"), body.checks)));
  } catch (e) {
    return fail(c, e);
  }
});

specRoutes.post("/:slug/session", async (c) => {
  const body = await jsonBody(c);
  const sessionId = str(body?.sessionId);
  if (!sessionId) return c.json(err("sessionId is required"), 400);
  try {
    return c.json(ok(await attachSession(c.get("projectPath"), c.req.param("slug"), sessionId)));
  } catch (e) {
    return fail(c, e);
  }
});

specRoutes.post("/:slug/submit/:phase", async (c) => {
  const phase = c.req.param("phase");
  if (!isSpecPhase(phase)) return c.json(err("Unknown phase"), 400);
  try {
    return gate(c, await submitPhase(c.get("projectPath"), c.req.param("slug"), phase));
  } catch (e) {
    return fail(c, e);
  }
});

/** What the spec's chat is told after an approval, so the AI goes on; null when it should wait. */
function afterApproval(view: Awaited<ReturnType<typeof getSpec>>, phase: SpecPhase | "drawing"): string | null {
  if (phase === "drawing") return "I approved the UI drawing. Go on with design.md and submit it when it is ready.";
  const file = phaseFileName(view.kind, phase);
  if (view.current === "execution") return null; // the tasks wait for Start task or Run all
  const next = view.phases[view.current];
  return `I approved ${file}. Go on with ${next.file}${next.status === "missing" ? "" : " (its template is there)"}, and submit it when it is ready.`;
}

specRoutes.post("/:slug/approve/:phase", async (c) => {
  const phase = c.req.param("phase");
  if (!isSpecPhase(phase) && phase !== "drawing") return c.json(err("Unknown phase"), 400);
  const body = (await jsonBody(c)) ?? {};
  try {
    const projectPath = c.get("projectPath");
    const r = await approvePhase(projectPath, c.req.param("slug"), phase);
    if (r.ok && body.continue === true) {
      const text = afterApproval(r.view, phase);
      if (text) void tellSpecChat(projectPath, r.view.sessionId, text);
    }
    return gate(c, r);
  } catch (e) {
    return fail(c, e);
  }
});

specRoutes.post("/:slug/request-changes/:phase", async (c) => {
  const phase = c.req.param("phase");
  if (!isSpecPhase(phase) && phase !== "drawing") return c.json(err("Unknown phase"), 400);
  const body = await jsonBody(c);
  const note = str(body?.note, 4000);
  if (!note) return c.json(err("Say what should change"), 400);
  try {
    const projectPath = c.get("projectPath");
    const view = await requestChanges(projectPath, c.req.param("slug"), phase, note);
    if (body?.continue === true) {
      const what = phase === "drawing" ? "the UI drawing" : phaseFileName(view.kind, phase);
      void tellSpecChat(projectPath, view.sessionId, `Please change ${what}: ${note}\n\nSubmit it again when it is done.`);
    }
    return c.json(ok(view));
  } catch (e) {
    return fail(c, e);
  }
});

specRoutes.post("/:slug/tasks/:id/:action", async (c) => {
  const projectPath = c.get("projectPath");
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  if (!/^\d+$/.test(id)) return c.json(err("Unknown task"), 400);
  const body = (await jsonBody(c)) ?? {};
  try {
    switch (c.req.param("action")) {
      case "start": return gate(c, await startTask(projectPath, slug, id, { sessionId: str(body.sessionId) }));
      case "done": return gate(c, await taskDone(projectPath, slug, id, str(body.summary, 2000) ?? ""));
      case "red": return gate(c, await taskRed(projectPath, slug, id));
      case "green": return gate(c, await taskGreen(projectPath, slug, id));
      case "reset": return c.json(ok(await resetTask(projectPath, slug, id)));
      // Start task (Kiro's button): the spec's own chat is asked to run it.
      case "run": {
        const view = await getSpec(projectPath, slug);
        const t = view.tasks.find((x) => x.id === id);
        if (!t) return c.json(err("Unknown task"), 404);
        if (t.next !== "start") return c.json(err(t.blockedReason ?? `Task ${id} cannot start now.`), 409);
        if (!view.sessionId) return c.json(err("This spec has no chat to run the task in; use Run all."), 409);
        const told = await tellSpecChat(projectPath, view.sessionId, `Run task ${id}: ${t.title}.`);
        return told ? c.json(ok({ message: `Task ${id} was handed to the spec's chat.`, spec: view })) : c.json(err("The spec's chat could not take the task."), 409);
      }
      default: return c.json(err("Unknown action"), 404);
    }
  } catch (e) {
    return fail(c, e);
  }
});

specRoutes.post("/:slug/suite/check", async (c) => {
  try {
    const r = await checkSuite(c.get("projectPath"), c.req.param("slug"));
    return c.json(ok({ ok: r.ok, message: r.message, spec: r.view }));
  } catch (e) {
    return fail(c, e);
  }
});

specRoutes.post("/:slug/run", async (c) => {
  const projectPath = c.get("projectPath");
  const slug = c.req.param("slug");
  const body = (await jsonBody(c)) ?? {};
  try {
    const view = await getSpec(projectPath, slug);
    // Each task chat runs on the provider named, else the spec chat's, else the default one.
    const named = str(body.providerId);
    const providerId = named ?? (view.sessionId ? getSessionProvider(view.sessionId) : null) ?? providerRegistry.getDefault()?.id;
    if (!providerId || !providerRegistry.get(providerId)) return c.json(err(`Provider "${providerId}" not found`), 400);
    const r = await startRun(projectPath, slug, { providerId, permissionMode: str(body.permissionMode) });
    return r.ok ? c.json(ok({ message: r.message, spec: await getSpec(projectPath, slug) })) : c.json(err(r.message), 409);
  } catch (e) {
    return fail(c, e);
  }
});

specRoutes.post("/:slug/stop", async (c) => {
  const projectPath = c.get("projectPath");
  const slug = c.req.param("slug");
  try {
    const r = await stopRun(projectPath, slug);
    return c.json(ok({ message: r.message, spec: await getSpec(projectPath, slug) }));
  } catch (e) {
    return fail(c, e);
  }
});
