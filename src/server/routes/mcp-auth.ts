/**
 * MCP sign-in (OAuth) for servers that report `needs-auth`.
 *
 * Everything here is behind PPM's auth except `mcpAuthCallbackHandler`: the authorization
 * server redirects the *browser* there by a top-level navigation, which carries no PPM
 * token. It is safe to leave open because it can only complete a flow an authenticated
 * user started — it matches the redirect's single-use OAuth `state` to a waiting flow, and
 * the CLI checks that state again before exchanging the code.
 */
import { Hono, type Context } from "hono";
import { homedir } from "node:os";
import { ok, err } from "../../types/api.ts";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import { mcpOAuthFlows, McpAuthFlowNotFoundError, type McpOAuthFlows } from "../../services/mcp-oauth/mcp-oauth-flows.ts";
import { mcpStatusProbe } from "../../services/mcp-oauth/mcp-status-probe.ts";
import { callbackUrlFor, customRedirectUri } from "../../services/mcp-oauth/mcp-oauth-redirect.ts";

// A cached status would still say `needs-auth` right after a sign-in.
mcpOAuthFlows.onAuthorized(() => mcpStatusProbe.invalidate());

export const mcpAuthRoutes = new Hono();

/** Directory whose MCP configuration applies: the project's, or the home directory. */
function cwdFor(project: string | undefined): string {
  return project ? resolveProjectPath(project) : homedir();
}

// GET /status?project=<name>&fresh=1 — every server's connection state
mcpAuthRoutes.get("/status", async (c) => {
  let cwd: string;
  try { cwd = cwdFor(c.req.query("project")); } catch (e) { return c.json(err((e as Error).message), 404); }
  try {
    const servers = await mcpStatusProbe.status(cwd, { fresh: c.req.query("fresh") === "1" });
    return c.json(ok(servers));
  } catch (e) {
    return c.json(err(`Could not read MCP status: ${(e as Error).message}`), 500);
  }
});

// POST /start { server, project?, origin? } — begin a sign-in, returns the flow
mcpAuthRoutes.post("/start", async (c) => {
  const body = await c.req.json<{ server?: string; project?: string; origin?: string }>().catch(() => ({} as Record<string, undefined>));
  if (!body.server || typeof body.server !== "string") return c.json(err("Missing required field: server"), 400);
  let cwd: string;
  try { cwd = cwdFor(body.project); } catch (e) { return c.json(err((e as Error).message), 404); }
  const redirectUri = customRedirectUri(body.origin, [c.req.header("x-forwarded-host"), c.req.header("host")]);
  try {
    return c.json(ok(await mcpOAuthFlows.start(body.server, cwd, redirectUri)));
  } catch (e) {
    return c.json(err(`Could not start the sign-in: ${(e as Error).message}`), 500);
  }
});

mcpAuthRoutes.get("/flows/:id", (c) => {
  const flow = mcpOAuthFlows.get(c.req.param("id"));
  return flow ? c.json(ok(flow)) : c.json(err("This sign-in is no longer active. Start again."), 404);
});

// POST /flows/:id/callback { url } — the redirect URL the user pasted
mcpAuthRoutes.post("/flows/:id/callback", async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }));
  if (!body.url || typeof body.url !== "string" || body.url.length > 16_384) {
    return c.json(err("Paste the full address from the browser after signing in."), 400);
  }
  return flowAction(c, () => mcpOAuthFlows.submitCallback(c.req.param("id"), body.url!.trim()));
});

// POST /flows/:id/confirm — "I've granted access" for a claude.ai connector
mcpAuthRoutes.post("/flows/:id/confirm", (c) => flowAction(c, () => mcpOAuthFlows.confirm(c.req.param("id"))));

mcpAuthRoutes.delete("/flows/:id", (c) => {
  const flow = mcpOAuthFlows.cancel(c.req.param("id"));
  return flow ? c.json(ok(flow)) : c.json(err("Sign-in not found"), 404);
});

async function flowAction(c: Context, run: () => Promise<unknown>) {
  try {
    return c.json(ok(await run()));
  } catch (e) {
    if (e instanceof McpAuthFlowNotFoundError) return c.json(err(e.message), 404);
    return c.json(err((e as Error).message), 500);
  }
}

/** GET /api/mcp-auth/callback — PUBLIC. Where the authorization server sends the browser back. */
export function createMcpAuthCallbackHandler(flows: McpOAuthFlows) {
  return async (c: Context) => {
    const url = new URL(c.req.url);
    const flow = flows.findByState(url.searchParams.get("state"));
    // A flow without a redirect URI uses the CLI's own localhost listener; its state
    // arriving here means somebody is replaying it, not completing it.
    if (!flow || !flow.redirectUri) {
      return c.html(page("Sign-in not found", "This sign-in link is no longer active. Start the sign-in again from PPM."), 404);
    }
    const serverName = flow.serverName;
    const result = await flows.submitCallback(flow.id, callbackUrlFor(flow.redirectUri, url.search));
    if (result.status === "done") {
      return c.html(page("Signed in", `${serverName} is connected. You can close this tab and return to PPM.`, true));
    }
    return c.html(page("Sign-in failed", result.error ?? `Could not finish signing in to ${serverName}.`), 400);
  };
}

export const mcpAuthCallbackHandler = createMcpAuthCallbackHandler(mcpOAuthFlows);

function page(title: string, message: string, closeSoon = false): string {
  // Best effort: after the cross-site redirects most browsers refuse to let a tab close
  // itself, and then the message simply stays.
  const script = closeSoon ? "<script>setTimeout(function(){window.close()},1500)</script>" : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5;color-scheme:light dark}</style>`
    + `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${script}</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
