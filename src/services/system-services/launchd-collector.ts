/**
 * The Services page's backend on macOS: one `launchctl print` per domain for the
 * list, a job's own `print` for its details, and `kickstart` / `kill` / `enable` /
 * `disable` for the actions. The same three entry points as the systemd collector,
 * behind the same `ServiceBackend` the routes take.
 *
 * Three domains stand in for systemd's two managers: `system`, and for the user both
 * of the user's own. The GUI session's `gui/<uid>` is where login items and
 * ~/Library/LaunchAgents load; the background session's `user/<uid>` is its parent
 * and holds a set of its own — 84 jobs beside the GUI domain's 450 on the Mac this
 * was written on, none in both, since an agent allowed in both sessions loads once,
 * in the background one. A Mac nobody is logged into at the screen has no GUI domain
 * at all. A label lives in one domain only, and launchd answers for it there alone
 * ("Could not find service" from the other), so details and actions ask launchd
 * which one holds the label instead of assuming the GUI's.
 *
 * Stop is `kill SIGTERM`, not `bootout`. A job that is booted out leaves launchd's
 * list — and this page — until the next login, and most third-party jobs on a Mac
 * have no property list on disk to load them from again: on the machine this was
 * written on, 13 of 24 were login-item helpers registered through ServiceManagement
 * or updaters an app submitted at run time. Killed, a job stays loaded and Start
 * brings it back. The price is launchd's own rule: a job set to KeepAlive starts
 * again by itself, which the action reports rather than hides — measured, 0.05 s
 * after the kill for a job that had run a while, 8.2 s for one started 2 s before,
 * because launchd never respawns a job sooner than 10 s after it last started.
 */
import { userInfo } from "node:os";
import type {
  ServiceAction, ServiceActionResult, ServiceDetails, ServiceInfo, ServiceScope, ServicesSnapshot,
} from "../../types/system-services.ts";
import type { RunResult, Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";
import {
  describeExit, isAppInstance, jobProperties, lastExitFromFields, parseDomainPrint, parseJobPrint,
  parseLastExit, parseLstart, parseOverrides, pidField, toLaunchdServiceInfo, topLevelBlock, type DomainJob,
  type LaunchdOverride,
} from "./launchd-parse.ts";
import {
  ancestorsOf, checkLaunchdActionAllowed, isPlausibleLaunchdLabel, launchdRefusals, selfJobLabels,
  type LaunchdGuardContext,
} from "./launchd-guard.ts";
import { createLaunchdLogReader, type LaunchdLogReader } from "./launchd-logs.ts";
import { launchdJobIndex, type LaunchdJobIndex } from "./launchd-job-index.ts";
import { failureText, ServiceActionRefused } from "./systemd-collector.ts";
import type { ServiceBackend } from "./service-backend.ts";

export const LAUNCHCTL_TIMEOUT_MS = 10_000;
export const ACTION_TIMEOUT_MS = 20_000;

export interface LaunchdDeps {
  run: Runner;
  /** PPM's uid, which names the user's domains. */
  uid: number;
  /** The login name a LaunchAgent runs as: launchd prints no user for one. */
  userName: string;
  /** PPM's pid and the XPC_SERVICE_NAME it was started with, for finding its own job. */
  pid: number;
  serviceName: string | undefined;
  logs: LaunchdLogReader;
  /** Where each listing leaves its main pids for the metrics tick. */
  jobIndex: LaunchdJobIndex;
}

export const launchdTarget = (domain: string, label: string) => `${domain}/${label}`;

/** launchctl splits one error over two lines ("Bad request.\nCould not find service …"). */
export function launchctlFailureText(result: RunResult): string {
  return failureText(result).replace(/\s*\n\s*/g, " ");
}

const NO_SUCH_DOMAIN = /could not find domain/i;

export const keepAliveNote = (label: string) =>
  `launchd keeps ${label} alive, so it starts again by itself. Disable it and it stays stopped from the next login.`;

const ACTION_ARGV: Record<Exclude<ServiceAction, "stop">, (target: string) => string[]> = {
  start: (target) => ["launchctl", "kickstart", target],
  restart: (target) => ["launchctl", "kickstart", "-k", target],
  enable: (target) => ["launchctl", "enable", target],
  disable: (target) => ["launchctl", "disable", target],
};

interface ScopeListing {
  scope: ServiceScope;
  ok: boolean;
  jobs: DomainJob[];
  overrides: Map<string, LaunchdOverride>;
  warnings: string[];
}

function scopeListing(scope: ServiceScope, domain: string, result: RunResult): ScopeListing {
  const failed = (why: string): ScopeListing => ({
    scope, ok: false, jobs: [], overrides: new Map(), warnings: [`${domain} jobs unavailable: ${why}`],
  });
  // No GUI session, no GUI domain: there is nothing in it to list.
  if (!result.timedOut && result.code !== 0 && NO_SUCH_DOMAIN.test(`${result.stdout}\n${result.stderr}`)) {
    return { scope, ok: true, jobs: [], overrides: new Map(), warnings: [] };
  }
  if (result.timedOut || result.code !== 0) return failed(launchctlFailureText(result));
  const listing = parseDomainPrint(result.stdout);
  if (!listing) return failed("launchctl printed no services block");
  // App instances are the Apps page's business, one per launch of every app.
  const jobs = listing.jobs.filter((job) => !isAppInstance(job.label));
  return { scope, ok: true, jobs, overrides: listing.overrides, warnings: [] };
}

export function createLaunchdBackend(deps: LaunchdDeps = defaultLaunchdDeps()): ServiceBackend {
  /** PPM's own job(s), resolved once from a listing that reached every domain. */
  let selfLabels: Set<string> | null = null;
  const domains: readonly [ServiceScope, string][] = [
    ["system", "system"], ["user", `gui/${deps.uid}`], ["user", `user/${deps.uid}`],
  ];

  const print = (target: string) => deps.run(["launchctl", "print", target], LAUNCHCTL_TIMEOUT_MS);

  /** Every domain, printed side by side. All of them on every listing: someone can
   *  log in at the screen after PPM started, and the GUI domain appears then. */
  async function listDomains(): Promise<ScopeListing[]> {
    const results = await Promise.all(domains.map(([, domain]) => print(domain)));
    return domains.map(([scope, domain], i) => scopeListing(scope, domain, results[i]!));
  }

  /**
   * The domain that holds `label` now, and the job's `print` from it: each of the
   * scope's domains is asked in turn, so a job is looked at and acted on in the one
   * it was listed from. A label none of them holds is aimed at the first — the GUI
   * domain for a user job — and launchctl's own answer stands.
   */
  async function locate(label: string, scope: ServiceScope) {
    let first: { domain: string; target: string; job: RunResult } | undefined;
    for (const [s, domain] of domains) {
      if (s !== scope) continue;
      const target = launchdTarget(domain, label);
      const job = await print(target);
      if (!job.timedOut && job.code === 0) return { domain, target, job };
      first ??= { domain, target, job };
    }
    return first!;
  }

  async function ancestors(): Promise<number[]> {
    const ps = await deps.run(["ps", "-Ao", "pid=,ppid="], LAUNCHCTL_TIMEOUT_MS);
    const ppidOf = new Map<number, number>();
    for (const line of ps.stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) ppidOf.set(Number(m[1]), Number(m[2]));
    }
    return ancestorsOf(deps.pid, ppidOf);
  }

  async function guardContext(listings?: readonly ScopeListing[]): Promise<LaunchdGuardContext> {
    if (!selfLabels) {
      const scopes = listings ?? await listDomains();
      const labels = selfJobLabels(deps.serviceName, await ancestors(), scopes.flatMap((s) => s.jobs));
      // Kept only once every domain answered: a job missing from a failed listing
      // must not leave PPM's own job unprotected for the life of the server.
      if (scopes.every((s) => s.ok)) selfLabels = labels;
      return { uid: deps.uid, selfLabels: labels };
    }
    return { uid: deps.uid, selfLabels };
  }

  const withRefusals = (info: ServiceInfo, ctx: LaunchdGuardContext): ServiceInfo => {
    const refused = launchdRefusals(info.unit, info.scope, ctx);
    return Object.keys(refused).length > 0 ? { ...info, refused } : info;
  };

  return {
    manager: "launchd",
    isName: isPlausibleLaunchdLabel,

    async collect(): Promise<ServicesSnapshot> {
      const listings = await listDomains();
      const ctx = await guardContext(listings);
      const services: ServiceInfo[] = [];
      const mainPids: [number, string][] = [];
      for (const { scope, jobs, overrides } of listings) {
        for (const job of jobs) {
          const info = toLaunchdServiceInfo({ ...job, exit: parseLastExit(job.status) }, scope, overrides.get(job.label));
          services.push(withRefusals(info, ctx));
          if (job.pid !== null) mainPids.push([job.pid, `${scope}:${job.label}`]);
        }
      }
      deps.jobIndex.update(mainPids);
      return {
        supported: listings.some((l) => l.ok),
        manager: "launchd",
        services,
        warnings: listings.flatMap((l) => l.warnings),
      };
    },

    async details(label: string, scope: ServiceScope): Promise<ServiceDetails | null> {
      const { domain, job } = await locate(label, scope);
      if (job.timedOut || job.code !== 0) return null;
      const disabled = await deps.run(["launchctl", "print-disabled", domain], LAUNCHCTL_TIMEOUT_MS);
      const parsed = parseJobPrint(job.stdout);
      if (!parsed) return null;
      const f = parsed.fields;
      const pid = pidField(f);
      const exit = lastExitFromFields(f);
      // Without the overrides the job reads as enabled, which is launchd's default too.
      const override = disabled.code === 0
        ? parseOverrides(topLevelBlock(disabled.stdout, "disabled services")).get(label)
        : undefined;
      const info = withRefusals(toLaunchdServiceInfo({ label, pid, exit }, scope, override), await guardContext());
      const program = f.get("program") ?? null;
      const stdoutPath = f.get("stdout path") ?? null;
      const stderrPath = f.get("stderr path") ?? null;
      // How far back a query by pid may reach: pids wrap, so before the start the
      // same number named another process.
      const started = pid === null ? null : await deps.run(["ps", "-o", "lstart=", "-p", String(pid)], LAUNCHCTL_TIMEOUT_MS);
      const startedAt = started && started.code === 0 && !started.timedOut ? parseLstart(started.stdout) : null;
      const log = await deps.logs.read({ stdoutPath, stderrPath, pid, startedAt, program });
      return {
        ...info,
        // A daemon without UserName runs as root; an agent runs as the session's user.
        user: f.get("username") ?? (scope === "user" ? deps.userName : "root"),
        group: f.get("group") ?? null,
        fragmentPath: f.get("path") ?? null,
        logs: log.lines,
        logSource: log.source,
        program,
        arguments: parsed.arguments,
        stdoutPath,
        stderrPath,
        lastExit: describeExit(exit) || "never exited",
        keepAlive: jobProperties(f).has("keepalive"),
      };
    },

    async action(label: string, scope: ServiceScope, action: ServiceAction): Promise<ServiceActionResult> {
      const verdict = checkLaunchdActionAllowed(label, scope, action, await guardContext());
      if (!verdict.allowed) throw new ServiceActionRefused(verdict.reason ?? "Refused");

      const { target, job: before } = await locate(label, scope);
      const done: ServiceActionResult = { unit: label, scope, action };
      if (action === "stop") {
        // Looked up first: `kill` on a job with no process is an error, where a stop
        // of a stopped unit is not one on systemd either.
        if (before.timedOut || before.code !== 0) throw new Error(launchctlFailureText(before));
        const job = parseJobPrint(before.stdout);
        if (!job || pidField(job.fields) === null) return { ...done, note: `${label} was not running` };
        const killed = await deps.run(["launchctl", "kill", "SIGTERM", target], ACTION_TIMEOUT_MS);
        if (killed.timedOut || killed.code !== 0) throw new Error(launchctlFailureText(killed));
        return jobProperties(job.fields).has("keepalive") ? { ...done, note: keepAliveNote(label) } : done;
      }
      const result = await deps.run(ACTION_ARGV[action](target), ACTION_TIMEOUT_MS);
      if (result.timedOut || result.code !== 0) throw new Error(launchctlFailureText(result));
      return done;
    },
  };
}

/** Production wiring. Nothing here spawns: the route module builds this at import. */
export function defaultLaunchdDeps(): LaunchdDeps {
  const uid = process.getuid?.() ?? -1;
  let userName = String(uid);
  try {
    userName = userInfo().username;
  } catch {
    // No passwd entry for this uid: the number is still who it runs as.
  }
  return {
    run: defaultRunner,
    uid,
    userName,
    pid: process.pid,
    serviceName: process.env.XPC_SERVICE_NAME,
    logs: createLaunchdLogReader(),
    jobIndex: launchdJobIndex(),
  };
}
