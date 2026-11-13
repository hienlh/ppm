import type { Command } from "commander";
import { inAiChat } from "../../services/ai-chat-env.ts";
import { ownForwardsInList, pickOwnForward, type TunnelRow } from "../../services/assistant-mcp/assistant-tunnel-host.ts";
import { ppmApiRequest } from "../utils/settings-request.ts";
import { C, fail, run } from "./chat-cmd-request.ts";
import { printTable } from "./cli-table.ts";

/**
 * `ppm forward`: the Port Forwarding panel's forwards, through `/api/tunnels` on the running PPM.
 * A forward is a child of the server that started it, so there is no fallback in this process:
 * one started here would end with the command.
 *
 * `stop` keeps the Assistant's own-forward rule (`pickOwnForward`): it reads the server's list and
 * stops only a forward that server started, never PPM's public link or another program's (or
 * another PPM's) cloudflared — the route itself would kill any unprotected one. `start` is refused
 * from an AI chat (advisory): a forward puts a port on an address until someone stops it, and the
 * Assistant's `port_forward_start` shows the user a card for that.
 */

const FORWARDS_SERVER_ONLY = "Port forwards live in the running PPM: a forward started from here would end with this command.";

interface TunnelList { tunnels: TunnelRow[]; scanFailed?: boolean }

function tunnelsRequest<T>(method: string, sub: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  return ppmApiRequest<T>(method, `/tunnels${sub}`, body, { serverOnly: FORWARDS_SERVER_ONLY, timeoutMs, progress: timeoutMs > 30_000 });
}

/** The server's fresh list (`force`: not the few-seconds cache), with which rows are its own. */
async function readForwards(): Promise<TunnelList & { ownPids: Set<number> }> {
  const list = await tunnelsRequest<TunnelList>("GET", "?detail=1&force=1");
  const tunnels = Array.isArray(list?.tunnels) ? list.tunnels : [];
  return { tunnels, scanFailed: list?.scanFailed === true, ownPids: new Set(ownForwardsInList(tunnels).map((f) => f.pid)) };
}

const startedBy = (row: TunnelRow, own: boolean) =>
  own ? "this PPM" : row.source === "app" ? "PPM's public link" : "another program";

function parsePositive(value: string, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${what} must be a positive whole number`);
  return n;
}

export function registerForwardCommands(program: Command): void {
  const forward = program.command("forward").description("Forward a localhost port, as the Port Forwarding panel does");

  forward
    .command("list")
    .description("List the forwards and the other cloudflared on this machine; `stop` takes only this PPM's")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const { tunnels, scanFailed, ownPids } = await readForwards();
      if (opts.json) {
        const rows = tunnels.map((t) => ({ ...t, stoppable: typeof t.pid === "number" && ownPids.has(t.pid) }));
        return void console.log(JSON.stringify({ tunnels: rows, scanFailed }, null, 2));
      }
      if (!tunnels.length) console.log(`${C.dim}No forwards.${C.reset}`);
      else {
        printTable(["PID", "Port", "Via", "Started by", "Address"], tunnels.map((t) => {
          const own = typeof t.pid === "number" && ownPids.has(t.pid);
          return [String(t.pid ?? ""), String(t.port ?? ""), t.via === "tailscale" ? "tailscale" : "cloudflare", startedBy(t, own), typeof t.url === "string" ? t.url : ""];
        }));
      }
      if (scanFailed) console.log(`${C.yellow}!${C.reset} The machine-wide scan did not finish: other programs' tunnels are as last seen.`);
    })());

  forward
    .command("start <port>")
    .description("Forward a localhost port: a public quick tunnel, or --via tailscale for your tailnet only. Refused from an AI chat (use port_forward_start)")
    .option("--via <transport>", "cloudflare or tailscale", "cloudflare")
    .action((portArg: string, opts: { via: string }) => run(async () => {
      if (inAiChat()) {
        fail("ppm forward start is refused here from an AI chat: a forward puts a port on an address until someone stops it. "
          + "Use the Assistant's port_forward_start tool (it shows the user a card), or give the user the command.");
      }
      const port = parsePositive(portArg, "The port");
      if (port > 65535) fail("The port must be from 1 to 65535");
      if (opts.via !== "cloudflare" && opts.via !== "tailscale") fail("--via must be cloudflare or tailscale");
      const made = await tunnelsRequest<{ url?: string | null }>("POST", "", { port, via: opts.via }, 120_000);
      const reach = opts.via === "tailscale" ? "devices on your tailnet" : "anyone with the address (no PPM login)";
      console.log(`${C.green}✓${C.reset} Port ${port} forwarded over ${opts.via}: ${made?.url ?? "(no address yet)"}`);
      console.log(`${C.dim}Reachable by ${reach}. It runs until \`ppm forward stop\` or until PPM restarts.${C.reset}`);
    })());

  forward
    .command("stop <pid>")
    .description("Stop a forward this PPM started (never PPM's public link or another program's tunnel)")
    .action((pidArg: string) => run(async () => {
      const pid = parsePositive(pidArg, "The pid");
      const { tunnels } = await readForwards();
      const target = pickOwnForward(ownForwardsInList(tunnels), { pid });
      if (typeof target === "string") fail(target);
      await tunnelsRequest("DELETE", `/${target.pid}`);
      console.log(`${C.green}✓${C.reset} Stopped forwarding port ${target.port} (pid ${target.pid}, ${target.via})`);
    })());
}
