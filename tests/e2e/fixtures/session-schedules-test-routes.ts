/**
 * The session-schedules fixture's own routes (`/__sched-test/*`): what the e2e arranges and reads
 * on the server side — the scripted turns' plans, the MCP calls they made and the turns each chat
 * ran, releasing a held turn, a schedule's stored row, a chat's live state, and making a schedule
 * come due now through the real timer, and arming the race where a person's turn starts between
 * a schedule's quiet check and its send. None exist in a real PPM.
 */
import { calls, plans, releaseHolds, sends, type TurnPlan } from "./session-collab-scripted-providers";
import { resolveMigratedSession, setSessionTitle } from "../../../src/services/db.service";
import { getSchedule, updateSchedule } from "../../../src/services/scheduler-db.service";
import { collabLiveState } from "../../../src/server/ws/chat";

interface Ctx { alpha: string; arm: (sessionId: string) => void }
const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function testRoute(req: Request, url: URL, ctx: Ctx): Promise<Response> {
  const path = url.pathname.slice("/__sched-test".length);
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
  if (path === "/title" && req.method === "POST") {
    setSessionTitle(String(body.sessionId), String(body.title));
    return json({ ok: true });
  }
  if (path === "/race" && req.method === "POST") {
    // The chat's next scheduled message finds a person's turn already running (see the racing provider).
    ctx.arm(resolveMigratedSession(String(body.sessionId)));
    return json({ ok: true });
  }
  if (path === "/schedule") return json({ schedule: getSchedule(Number(url.searchParams.get("id"))) });
  if (path === "/due" && req.method === "POST") {
    // The schedule's next fire, moved to `minutesAgo` before now; the scheduler's own timer finds it.
    const id = Number(body.id);
    if (!getSchedule(id)) return json({ error: "no such schedule" }, 404);
    const minutesAgo = typeof body.minutesAgo === "number" ? body.minutesAgo : 0;
    updateSchedule(id, { next_fire_at: new Date(Date.now() - minutesAgo * 60_000 - 1000).toISOString() });
    const { schedulerService } = await import("../../../src/services/scheduler.service");
    schedulerService.rearm();
    return json({ ok: true });
  }
  if (path === "/live") {
    const id = url.searchParams.get("sessionId") ?? "";
    const canonical = resolveMigratedSession(id);
    return json({ canonical, live: collabLiveState(canonical) ?? null });
  }
  return json({ error: "unknown test route" }, 404);
}
