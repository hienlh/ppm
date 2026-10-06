/**
 * PPM at a private address on the tailnet: the Tailscale Service `svc:<name>` answers at
 * `https://<name>.<tailnet>.ts.net` and proxies to PPM on this machine.
 *
 * The handler is set in the BACKGROUND (`--bg`, which `--service` requires): tailscaled
 * keeps it across PPM restarts and reboots, so the address keeps working whatever PPM is
 * doing. PPM's switch is therefore a desired state, re-applied when the server starts.
 *
 * PPM never takes over a service it did not set up: a `svc:<name>` already pointing
 * somewhere else is reported as a conflict, and replaced only when asked; turning PPM's
 * switch off clears the service only while it still points at PPM. That is also what keeps
 * a dev instance and the real one on the same machine from fighting over one name.
 */
import { configService } from "../config.service.ts";
import { getConfigValue, setConfigValue } from "../db.service.ts";
import { readStatus } from "../supervisor-state.ts";
import { broadcastGlobalEvent } from "../../server/ws/global.ts";
import { hostCli, isAccessDenied, type TailscaleCli } from "./tailscale-cli.ts";
import { readTailscaleSetup } from "./tailscale-state.ts";
import { blockingSetupStep, DEFAULT_SERVICE_NAME, serviceNameProblem, type TailscaleSetupState } from "../../shared/tailscale-setup.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("tailscale");

const SETTING_KEY = "tailscale_service";

export interface TailscaleServiceSetting {
  /** null: the switch was never used, so an address already pointing at PPM counts as on. */
  enabled: boolean | null;
  name: string;
  /** The target PPM last set, so a later start can tell its own stale handler from someone else's. */
  target: string | null;
}

export class TailscaleServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 500 = 500,
    /** "conflict": the name serves something else, which `replace` would take over. */
    readonly code?: "conflict",
  ) {
    super(message);
  }
}

export function readServiceSetting(): TailscaleServiceSetting {
  try {
    const raw = JSON.parse(getConfigValue(SETTING_KEY) ?? "{}") as Partial<TailscaleServiceSetting>;
    const name = typeof raw.name === "string" && !serviceNameProblem(raw.name) ? raw.name : DEFAULT_SERVICE_NAME;
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : null;
    return { enabled, name, target: typeof raw.target === "string" ? raw.target : null };
  } catch {
    return { enabled: null, name: DEFAULT_SERVICE_NAME, target: null };
  }
}

function writeServiceSetting(setting: TailscaleServiceSetting): void {
  setConfigValue(SETTING_KEY, JSON.stringify(setting));
}

let publicPort: number | null = null;

/**
 * Record the port people reach PPM on. Under the supervisor the server binds port 0 and
 * the edge forwarder owns the public port (in status.json), which outlives every server
 * restart; a server started on a fixed port (dev, `__serve__ <port>`) serves it itself.
 */
export function setPpmPublicPort(spawnPort: number, boundPort: number): void {
  if (spawnPort !== 0) { publicPort = boundPort; return; }
  const supervised = Number(readStatus().port);
  publicPort = Number.isInteger(supervised) && supervised > 0 ? supervised : null;
}

export function ppmPublicPort(): number {
  return publicPort ?? configService.get("port") ?? 8080;
}

const targetFor = (port: number) => `http://127.0.0.1:${port}`;

function announce(): void {
  broadcastGlobalEvent({ type: "tailscale:changed" });
}

/** The pane's state, for the saved name or for a name being typed. */
export async function readState(name?: string, cli: TailscaleCli = hostCli()): Promise<TailscaleSetupState> {
  const setting = readServiceSetting();
  const candidate = name && !serviceNameProblem(name) ? name : setting.name;
  const saved = candidate === setting.name;
  const state = await readTailscaleSetup({ serviceName: candidate, enabled: saved && setting.enabled === true, ppmPort: ppmPublicPort() }, cli);
  // An address someone set up by hand before PPM had this switch is on until the switch is used.
  if (saved && setting.enabled === null && state.service.pointsAtPpm) return { ...state, enabled: true };
  return state;
}

const MISSING: Record<NonNullable<ReturnType<typeof blockingSetupStep>>, string> = {
  install: "Install Tailscale on this machine first.",
  start: "Start Tailscale on this machine first.",
  operator: "Let PPM manage Tailscale first: run the operator command shown in Settings.",
  "sign-in": "Sign this machine in to Tailscale first.",
  dns: "Turn on MagicDNS and HTTPS certificates for your tailnet first.",
  tag: "Tag this machine first: Tailscale only lets tagged machines host a service.",
};

/** What still stands between this machine and hosting a service, or null. */
export function missingForService(state: TailscaleSetupState): string | null {
  const step = blockingSetupStep(state);
  return step ? MISSING[step] : null;
}

/** The CLI's refusal, in terms of the step that fixes it. */
export function serviceFailureMessage(stderr: string): string {
  if (isAccessDenied(stderr)) return "Tailscale refused to let PPM change its settings. Run the operator command shown in Settings, then try again.";
  if (/must be tagged/i.test(stderr)) return "Tailscale only lets tagged machines host a service. Tag this machine, then try again.";
  const text = stderr.trim().split("\n").filter(Boolean).slice(0, 3).join(" ");
  return text ? `tailscale serve failed: ${text}` : "tailscale serve failed";
}

async function serve(cli: TailscaleCli, args: string[]): Promise<void> {
  const result = await cli.runner([...cli.argv!, "serve", ...args], 20_000);
  if (result.code !== 0) throw new TailscaleServiceError(serviceFailureMessage(result.stderr || result.stdout));
}

const serviceArgs = (name: string, target: string) => [`--service=svc:${name}`, "--https=443", "--bg", "--yes", target];

/** Point `svc:<name>` at this PPM and remember the switch is on. */
export async function enableService(
  opts: { name?: string; replace?: boolean },
  cli: TailscaleCli = hostCli(),
): Promise<TailscaleSetupState> {
  const setting = readServiceSetting();
  const name = opts.name ?? setting.name;
  const problem = serviceNameProblem(name);
  if (problem) throw new TailscaleServiceError(problem, 400);
  if (!configService.get("auth").enabled) {
    throw new TailscaleServiceError("Turn on PPM's password first: anyone in your tailnet could otherwise open PPM.", 403);
  }

  const state = await readState(name, cli);
  const missing = missingForService(state);
  if (missing) throw new TailscaleServiceError(missing, 409);
  const foreign = !!state.service.target && !state.service.pointsAtPpm && state.service.target !== setting.target;
  if (foreign && !opts.replace) {
    throw new TailscaleServiceError(`svc:${name} already serves ${state.service.target}. Choose another name, or replace it.`, 409, "conflict");
  }

  const target = targetFor(state.ppmPort);
  await serve(cli, serviceArgs(name, target));
  // Moved to a new name: drop the old service once the new one is set, and only while it
  // is still PPM's. A failure above leaves both the old service and the setting as they were.
  const moved = !!setting.enabled && setting.name !== name;
  if (moved) {
    // Left behind, the old service keeps pointing at PPM under a name nobody manages.
    await clearIfOurs(setting, cli).catch((e) => log.warn(`Could not clear previous svc:${setting.name}: ${(e as Error).message}`));
  }
  writeServiceSetting({ enabled: true, name, target });
  log.info(`Tailscale svc:${name} → ${target} enabled (replaced=${foreign}${moved ? `, moved from svc:${setting.name}` : ""})`);
  announce();
  return readState(name, cli);
}

/** Clears `svc:<name>` only while it still points at PPM; returns whether it did. */
async function clearIfOurs(setting: TailscaleServiceSetting, cli: TailscaleCli): Promise<boolean> {
  const state = await readState(setting.name, cli);
  const ours = state.service.target !== null && (state.service.pointsAtPpm || state.service.target === setting.target);
  if (ours) await serve(cli, ["clear", `svc:${setting.name}`]);
  return ours;
}

/** Take PPM off its address and remember the switch is off. */
export async function disableService(cli: TailscaleCli = hostCli()): Promise<TailscaleSetupState> {
  const setting = readServiceSetting();
  const cleared = cli.argv ? await clearIfOurs(setting, cli) : false;
  writeServiceSetting({ ...readServiceSetting(), enabled: false });
  log.info(`Tailscale svc:${setting.name} disabled (cleared=${cleared})`);
  announce();
  return readState(setting.name, cli);
}

/** Change the name while the switch is off (it names the service the setup steps describe). */
export async function renameService(name: string, cli: TailscaleCli = hostCli()): Promise<TailscaleSetupState> {
  const problem = serviceNameProblem(name);
  if (problem) throw new TailscaleServiceError(problem, 400);
  if (readServiceSetting().name !== name && (await readState(undefined, cli)).enabled) {
    throw new TailscaleServiceError("Turn the address off before renaming it.", 409);
  }
  // Read again: the switch may have moved while the CLI answered.
  writeServiceSetting({ ...readServiceSetting(), name });
  return readState(name, cli);
}

/**
 * At server start: if the switch is on, make the service point at this PPM again. Waits
 * for tailscaled to be up (a machine booting starts PPM before Tailscale has connected),
 * and leaves a service alone that someone else has since pointed elsewhere.
 */
export async function ensureServiceOnStartup(
  opts: { cli?: TailscaleCli; attempts?: number; delayMs?: number } = {},
): Promise<"off" | "ok" | "applied" | "foreign" | "unavailable" | "failed"> {
  const cli = opts.cli ?? hostCli();
  const setting = readServiceSetting();
  if (!setting.enabled || !cli.argv) return "off";
  const attempts = opts.attempts ?? 40;
  const delayMs = opts.delayMs ?? 15_000;
  let lastBackend: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await Bun.sleep(delayMs);
    if (!readServiceSetting().enabled) return "off";
    const state = await readState(setting.name, cli);
    lastBackend = state.backendState;
    if (state.backendState !== "Running") continue;
    if (state.service.pointsAtPpm) return "ok";
    if (state.service.target && state.service.target !== setting.target) {
      log.warn(`svc:${setting.name} now serves ${state.service.target}; leaving it alone`);
      return "foreign";
    }
    // The caller does not act on the answer, so a give-up has to say why here.
    const missing = missingForService(state);
    if (missing) {
      log.warn(`svc:${setting.name} not re-applied at startup: ${missing}`);
      return "unavailable";
    }
    try {
      const target = targetFor(state.ppmPort);
      await serve(cli, serviceArgs(setting.name, target));
      writeServiceSetting({ ...readServiceSetting(), target });
      announce();
      log.info(`svc:${setting.name} → ${target}`);
      return "applied";
    } catch (e) {
      log.error(`Could not point svc:${setting.name} at ${targetFor(state.ppmPort)}: ${(e as Error).message}`);
      return "failed";
    }
  }
  log.warn(`svc:${setting.name} not re-applied at startup: tailscaled not Running after ${attempts} checks over ${Math.round(((attempts - 1) * delayMs) / 1000)}s (last state: ${lastBackend ?? "unknown"})`);
  return "unavailable";
}

/** The seam route tests patch. */
export const tailscaleAppService = { readState, enableService, disableService, renameService };
