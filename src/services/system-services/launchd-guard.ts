/**
 * Which launchd actions PPM refuses, and why: the macOS half of `service-guard.ts`,
 * with the same contract — one function produces both a row's `refused` map and the
 * action route's verdict, so a disabled button and a 403 cannot disagree.
 *
 * Four rules, in the order they are checked:
 *
 *  - The system domain belongs to root. launchd refuses every change there from any
 *    other user, so PPM says so up front instead of offering five buttons that fail.
 *  - An application's own instance (`application.*`), which Launch Services makes for
 *    every launch of every app. The Apps page shows those and this one does not, so
 *    only a request naming one directly gets here, and every action is refused:
 *    stopping one quits its app — the terminal PPM was started from, say, which the
 *    ancestor check below would not see, since the listing it reads leaves them out
 *    — and launchd would keep an enable/disable override for a label that dies with
 *    its launch.
 *  - PPM's own job. Stopping it ends the request that asked, and every session with
 *    it. It is found two ways, because each covers a start the other misses: the
 *    label launchd hands every process it spawns (`XPC_SERVICE_NAME`, which PPM's
 *    children inherit), and the job whose process is one of PPM's ancestors, which
 *    still works when something along the way cleared the environment.
 *  - macOS's own jobs (`com.apple.*`). Most would simply be started again, but not
 *    all: some cannot be loaded back until the next login, and a disabled one — the
 *    Dock, Finder — is missing from every login after it. Starting or enabling one
 *    takes nothing away and stays allowed.
 */
import type { ServiceAction, ServiceScope } from "../../types/system-services.ts";
import { SERVICE_ACTIONS } from "../../types/system-services.ts";
import type { ServiceActionVerdict } from "./service-guard.ts";
import { isAppInstance } from "./launchd-parse.ts";

/** Actions that take a running job away. `start` and `enable` never do. */
const DISRUPTIVE: readonly ServiceAction[] = ["stop", "restart", "disable"];

export interface LaunchdGuardContext {
  /** PPM's uid. Only root can change the system domain. */
  uid: number;
  /** The label of the job PPM runs under, by either route above. Usually one. */
  selfLabels: ReadonlySet<string>;
}

export const NOT_ROOT_REASON = "System jobs can only be changed by root, and PPM is not running as root";

export const appInstanceReason = (label: string) =>
  `${label} is one launch of an app, not a service — end it from the Apps page`;

/** Every action this job refuses, with the reason shown to the user. */
export function launchdRefusals(
  label: string,
  scope: ServiceScope,
  ctx: LaunchdGuardContext,
): Partial<Record<ServiceAction, string>> {
  const refusals: Partial<Record<ServiceAction, string>> = {};
  if (scope === "system" && ctx.uid !== 0) {
    for (const action of SERVICE_ACTIONS) refusals[action] = NOT_ROOT_REASON;
    return refusals;
  }
  if (isAppInstance(label)) {
    for (const action of SERVICE_ACTIONS) refusals[action] = appInstanceReason(label);
    return refusals;
  }
  const reason = ctx.selfLabels.has(label)
    ? `${label} is PPM itself — stopping it would end this session`
    : label.startsWith("com.apple.")
      ? `${label} is part of macOS — PPM will not stop it`
      : null;
  if (reason) for (const action of DISRUPTIVE) refusals[action] = reason;
  return refusals;
}

export function checkLaunchdActionAllowed(
  label: string,
  scope: ServiceScope,
  action: ServiceAction,
  ctx: LaunchdGuardContext,
): ServiceActionVerdict {
  if (!SERVICE_ACTIONS.includes(action)) return { allowed: false, reason: `Unknown action "${action}"` };
  if (!isPlausibleLaunchdLabel(label)) return { allowed: false, reason: "Not a job label" };
  const reason = launchdRefusals(label, scope, ctx)[action];
  return reason ? { allowed: false, reason } : { allowed: true };
}

/**
 * launchd labels are reverse-DNS by convention and by nothing else: they may be
 * mixed case with no suffix (`com.apple.DataDetectorsLocalSources`, which
 * `isPlausibleUnitName` refuses) or carry an `@` (`homebrew.mxcl.postgresql@16`).
 * What matters is that a label is spliced into a target, `gui/501/<label>`, so it
 * may not hold a slash, and it is one argv element that never reaches a shell;
 * whitespace and control characters are refused as well, since no real label has
 * them and a log line should not either.
 */
export function isPlausibleLaunchdLabel(label: string): boolean {
  return typeof label === "string"
    && label.length > 0
    && label.length <= 256
    && !/[\s/\u0000-\u001f\u007f]/.test(label);
}

/**
 * The labels of the job PPM runs under. `serviceName` is `XPC_SERVICE_NAME`, which
 * reads "0" in a shell opened from Terminal; `ancestors` are PPM's own pid and its
 * parents', and any job whose process is one of them is PPM's.
 */
export function selfJobLabels(
  serviceName: string | undefined,
  ancestors: readonly number[],
  jobs: Iterable<{ label: string; pid: number | null }>,
): Set<string> {
  const labels = new Set<string>();
  if (serviceName && serviceName !== "0") labels.add(serviceName);
  const chain = new Set(ancestors);
  for (const job of jobs) if (job.pid !== null && chain.has(job.pid)) labels.add(job.label);
  return labels;
}

/** `pid` and its ancestors up to (not including) launchd, from a pid → ppid table. */
export function ancestorsOf(pid: number, ppidOf: ReadonlyMap<number, number>): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  for (let p: number | undefined = pid; p !== undefined && p > 1 && !seen.has(p); p = ppidOf.get(p)) {
    seen.add(p);
    chain.push(p);
  }
  return chain;
}
