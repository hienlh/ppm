import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { killProcessTree } from "../../services/windows-process-tree.ts";
import {
  listTunnels,
  isCloudflaredPid,
  invalidateTunnelCache,
  type PpmTunnelInput,
} from "../../services/tunnel-registry.service.ts";
import {
  activeTunnels,
  spawnTunnelProcess,
  registerTunnel,
} from "./tunnel-spawn.ts";

/**
 * Tunnel registry API — manage ALL cloudflared processes on the machine.
 *
 * GET    /api/tunnels        → unified list (PPM + app + external)
 * POST   /api/tunnels {port} → start a PPM quick tunnel for a localhost port
 * DELETE /api/tunnels/:pid   → stop a tunnel by PID (safe-kill guarded)
 *
 * Safety: the app/supervisor tunnel is `protected` (409, never killable here);
 * a PID is only killed after its image is re-verified as cloudflared.
 */
export const tunnelRegistryRoutes = new Hono();

/** Snapshot PPM-spawned tunnels as registry inputs, using the LIVE process PID. */
function ppmSnapshot(): PpmTunnelInput[] {
  const out: PpmTunnelInput[] = [];
  for (const t of activeTunnels.values()) {
    out.push({ pid: t.process?.pid ?? t.pid, port: t.port, url: t.url, startedAt: t.startedAt });
  }
  return out;
}

/** GET /api/tunnels — unified tunnel list */
tunnelRegistryRoutes.get("/", async (c) => {
  // ?force=1 bypasses the 2s TTL cache (manual refresh from the panel).
  const force = c.req.query("force") === "1";
  const list = await listTunnels(ppmSnapshot(), { force });
  return c.json(ok(list));
});

/** POST /api/tunnels — start a PPM quick tunnel for a localhost port */
tunnelRegistryRoutes.post("/", async (c) => {
  const body = await c.req.json<{ port: number }>().catch(() => null);
  const port = body?.port;
  if (!port || port < 1 || port > 65535) {
    return c.json(err("Invalid port (1-65535)"), 400);
  }

  const existing = activeTunnels.get(port);
  if (existing) return c.json(ok({ port, url: existing.url }));

  try {
    const { process: proc, url } = await spawnTunnelProcess(port);
    registerTunnel(port, proc, url);
    invalidateTunnelCache();
    return c.json(ok({ port, url }));
  } catch (e: any) {
    return c.json(err(e.message || "Failed to start tunnel"), 500);
  }
});

/** DELETE /api/tunnels/:pid — stop a tunnel by PID */
tunnelRegistryRoutes.delete("/:pid{[0-9]+}", async (c) => {
  const pid = parseInt(c.req.param("pid"), 10);
  if (!pid || pid < 1) return c.json(err("Invalid pid"), 400);

  // Fresh list (force) so protection + identity reflect current state.
  const list = await listTunnels(ppmSnapshot(), { force: true });
  const entry = list.find((t) => t.pid === pid);
  if (!entry) return c.json(err("No tunnel found for this PID"), 404);

  // App/supervisor tunnel is display-only — never killable from the panel.
  if (entry.protected) {
    return c.json(err("Protected app tunnel; not stoppable from panel"), 409);
  }

  // Re-verify the image is really cloudflared immediately before killing —
  // guards PID reuse between enumeration and kill.
  if (!isCloudflaredPid(pid)) {
    return c.json(err("PID is no longer a cloudflared process"), 409);
  }

  // PPM-spawned tunnel → kill via the shared map so cleanup stays consistent.
  let ppmPort: number | null = null;
  for (const t of activeTunnels.values()) {
    if ((t.process?.pid ?? t.pid) === pid) { ppmPort = t.port; break; }
  }
  killProcessTree(pid);
  if (ppmPort != null) activeTunnels.delete(ppmPort);
  invalidateTunnelCache();

  return c.json(ok({ pid }));
});
