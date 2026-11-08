/**
 * The session-collaboration fixture's own routes (`/__collab-test/*`): what the e2e arranges and
 * reads on the server side — the scripted turns' plans, the MCP calls they made and the turns each
 * session ran, releasing held turns, a chain of created sessions for the depth limit, the
 * notifications the fake ntfy server received, and the cards waiting now. None exist in a real PPM.
 */
import { calls, plans, releaseHolds, sends, type TurnPlan } from "./session-collab-scripted-providers";
import { recordSpawn } from "../../../src/services/session-collab/session-links.service";
import { collabApprovalBroker } from "../../../src/services/session-collab/collab-approval-broker";
import { resolveMigratedSession, setSessionTitle } from "../../../src/services/db.service";
import { collabLiveState } from "../../../src/server/ws/chat";

interface Ctx { alpha: string; ntfyPublished: () => Array<Record<string, unknown>> }
const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function testRoute(req: Request, url: URL, ctx: Ctx): Promise<Response> {
  const path = url.pathname.slice("/__collab-test".length);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) as Record<string, unknown> : {};
  if (path === "/project") return json({ alpha: ctx.alpha });
  if (path === "/calls") return json({ calls });
  if (path === "/sends") return json({ sends });
  if (path === "/plan" && req.method === "POST") {
    const key = String(body.key);
    plans.set(key, [...(plans.get(key) ?? []), ...(body.plans as TurnPlan[])]);
    return json({ ok: true });
  }
  if (path === "/release" && req.method === "POST") {
    return json({ released: releaseHolds(typeof body.sessionId === "string" ? body.sessionId : undefined) });
  }
  if (path === "/spawn-chain" && req.method === "POST") {
    // Each id created by the one before it, as a chain of AI-created sessions would be.
    const ids = body.ids as string[];
    const depths = ids.slice(1).map((id, i) => recordSpawn(id, ids[i]!));
    return json({ depths });
  }
  if (path === "/title" && req.method === "POST") {
    // What renaming a chat stores: the title every list and every from-session header shows.
    setSessionTitle(String(body.sessionId), String(body.title));
    return json({ ok: true });
  }
  if (path === "/ntfy") return json({ published: ctx.ntfyPublished() });
  if (path === "/pending-cards") return json({ count: collabApprovalBroker.pendingCount() });
  if (path === "/live") {
    const id = url.searchParams.get("sessionId") ?? "";
    const canonical = resolveMigratedSession(id);
    return json({ canonical, live: collabLiveState(canonical) ?? null });
  }
  return json({ error: "unknown test route" }, 404);
}
