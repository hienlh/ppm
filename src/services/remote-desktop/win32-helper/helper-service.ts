/**
 * PPM's side of the Windows helper: is it installed (and for this user), install/uninstall it
 * through one administrator prompt, and run one of its fixed tasks.
 *
 * PPM never runs elevated. Installing stages the scripts in PPM's folder, then asks Windows for
 * elevation with a bootstrap that verifies them by hash (see `install-script.ts`). Running an
 * action is `schtasks /run` of a task whose command line is fixed — nothing is passed — and the
 * answer comes back through `state\last-run.json`, which only SYSTEM and administrators write.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createLogger } from "../../logger.ts";
import {
  helperPaths, HELPER_VERSION, MIN_USABLE_HELPER_VERSION, powershellExe, PPM_HELPER_ACTIONS, schtasksExe, taskName, whoamiExe, type HelperAction, type PpmHelperAction,
} from "./helper-paths.ts";
import { helperSystem, type HelperSystem } from "./helper-system.ts";
import {
  buildBootstrap, buildElevationLauncher, buildInstallScript, buildUninstallScript,
  EXIT_ELEVATION_REFUSED, EXIT_INSTALL_FAILED, EXIT_OK, EXIT_PAYLOAD_CHANGED, type StagedPayload,
} from "./install-script.ts";
import { encodePowerShell, isAscii, parseWhoamiUserCsv } from "./powershell-text.ts";
import { helperInstallPlan } from "./helper-install-plan.ts";
import { parseJson } from "./helper-json.ts";

const log = createLogger("remote-desktop");

export interface HelperRunResult {
  ok: boolean;
  message: string;
  /** The task was started but has not answered yet: whether it did anything is not known.
   *  Never reported as a failure — the page re-reads the host's real state instead. */
  pending?: boolean;
}
export interface HelperJob { kind: "install" | "uninstall"; state: "running" | "done" | "error"; message: string | null }
export interface HelperStatus {
  supported: boolean;
  /** Installed, a version PPM still runs, for this user, every task present: PPM can use it. */
  usable: boolean;
  installed: boolean;
  /** The installed version, or null when there is none (or no record of it). */
  version: number | null;
  /** Installed by an older PPM: an update is available. Still usable unless `tooOld`. */
  outdated: boolean;
  /** Older than `MIN_USABLE_HELPER_VERSION`: refused until updated. */
  tooOld: boolean;
  /** Installed for another Windows user; this user's PPM cannot run its tasks. */
  otherUser: boolean;
  virtualDisplay: boolean;
  lastRun: { action: string; ok: boolean; message: string; at: string } | null;
  /** The safety net waiting to be confirmed (the viewer confirms once a picture comes through), or null. */
  rescue: RescueState | null;
  job: HelperJob | null;
}

/** `state\rescue.json`, written by the SYSTEM helper only (`rescue-script.ts`). */
export interface RescueState {
  /** The action that armed it: `Reattach` or `DisplayOn`. */
  action: string;
  armedMs: number;
  /** When the `Rescue` task runs unless confirmed first. */
  deadlineMs: number;
}

/** Cheap enough to poll: one small file read, no process. */
export function getRescueState(): RescueState | null {
  const sys = helperSystem();
  if (sys.platform !== "win32") return null;
  const raw = parseJson<Partial<RescueState>>(sys.readText(join(helperPaths().stateDir, "rescue.json")));
  if (!raw || typeof raw.action !== "string" || typeof raw.deadlineMs !== "number" || typeof raw.armedMs !== "number") return null;
  return { action: raw.action, armedMs: raw.armedMs, deadlineMs: raw.deadlineMs };
}

const STATUS_TTL_MS = 5000;
const RUN_TIMEOUT_MS = 15_000;
/** How long a request waits for the helper. The slowest run measured on a real host was 27 s
 *  (a DisplayOn while a capture was running); twice that, plus margin. */
export const ANSWER_WAIT_MS = 60_000;
/** After that, how long PPM keeps watching for a late answer in the background, so that what the
 *  helper did is still recorded (above all: who turned the virtual display on). Under the task's
 *  own 2-minute execution limit, plus its start. */
export const LATE_ANSWER_MS = 3 * 60_000;
/** What the page is told when the wait runs out. */
export const PENDING_MESSAGE = "The PC has not answered yet, so it is not known whether this happened. "
  + "PPM keeps checking; the list shows the PC's real state.";
const ELEVATION_TIMEOUT_MS = 10 * 60_000;

let cachedSid: string | null = null;
let cachedStatus: { at: number; status: HelperStatus } | null = null;
let job: HelperJob | null = null;
let running: Promise<HelperRunResult> | null = null;

/** Tests only. */
export function resetHelperServiceForTests(): void {
  cachedSid = null; cachedStatus = null; job = null; running = null; lateWatches.clear();
}

async function currentUserSid(sys: HelperSystem): Promise<string | null> {
  if (cachedSid) return cachedSid;
  const r = await sys.run([whoamiExe(), "/user", "/fo", "csv", "/nh"], RUN_TIMEOUT_MS);
  cachedSid = r.code === 0 ? parseWhoamiUserCsv(r.stdout) : null;
  return cachedSid;
}

async function taskExists(sys: HelperSystem, action: HelperAction): Promise<boolean> {
  return (await sys.run([schtasksExe(), "/query", "/tn", taskName(action)], RUN_TIMEOUT_MS)).code === 0;
}

export async function getHelperStatus(force = false): Promise<HelperStatus> {
  const sys = helperSystem();
  const unsupported: HelperStatus = {
    supported: false, usable: false, installed: false, version: null, outdated: false, tooOld: false, otherUser: false,
    virtualDisplay: false, lastRun: null, rescue: null, job,
  };
  if (sys.platform !== "win32") return unsupported;
  if (!force && cachedStatus && sys.now() - cachedStatus.at < STATUS_TTL_MS) return { ...cachedStatus.status, job };
  const paths = helperPaths();
  const record = parseJson<{ version?: number; userSid?: string; actions?: string[] }>(sys.readText(paths.installRecord));
  const installed = !!record && sys.exists(paths.helperScript);
  const sid = await currentUserSid(sys);
  const otherUser = installed && (!sid || record?.userSid !== sid);
  const version = installed && typeof record?.version === "number" ? record.version : null;
  const outdated = installed && (version === null || version < HELPER_VERSION);
  const tooOld = installed && (version === null || version < MIN_USABLE_HELPER_VERSION);
  const plan = helperInstallPlan();
  let tasksPresent = false;
  if (installed && !otherUser && !tooOld) {
    // Only the tasks PPM starts: `Rescue` is not even readable by this user, by design.
    const mine = plan.actions.filter((a): a is PpmHelperAction => (PPM_HELPER_ACTIONS as readonly string[]).includes(a));
    tasksPresent = (await Promise.all(mine.map((a) => taskExists(sys, a)))).every(Boolean);
  }
  const status: HelperStatus = {
    supported: true,
    usable: installed && !otherUser && !tooOld && tasksPresent,
    installed, version, outdated, tooOld, otherUser,
    virtualDisplay: installed && (record?.actions ?? []).includes("DisplayOn"),
    lastRun: parseJson(sys.readText(paths.lastRun)),
    rescue: getRescueState(),
    job,
  };
  cachedStatus = { at: sys.now(), status };
  return status;
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function stage(sys: HelperSystem, name: string, variable: string, text: string): StagedPayload {
  if (!isAscii(text)) throw new Error(`${name} must be ASCII`);
  const path = join(helperPaths().stagingDir, name);
  sys.writeText(path, text);
  return { variable, path, sha256: sha256(text) };
}

function explainExit(sys: HelperSystem, code: number | null): HelperRunResult {
  if (code === EXIT_OK) return { ok: true, message: "Done." };
  if (code === EXIT_ELEVATION_REFUSED) {
    return { ok: false, message: "The administrator prompt was declined, or there was nobody signed in at the PC to see it. "
      + "Set this up while you are at the PC or connected with RDP/TeamViewer." };
  }
  if (code === EXIT_PAYLOAD_CHANGED) {
    return { ok: false, message: "The staged files changed before the administrator step read them, so nothing was installed." };
  }
  if (code === EXIT_INSTALL_FAILED) {
    const result = parseJson<{ message?: string }>(sys.readText(join(helperPaths().stateDir, "install-result.json")));
    return { ok: false, message: `The administrator step failed: ${result?.message ?? "no details were written."}` };
  }
  return { ok: false, message: `The administrator step ended with code ${code ?? "none (timed out)"}.` };
}

async function elevate(sys: HelperSystem, kind: "install" | "uninstall"): Promise<HelperRunResult> {
  const sid = await currentUserSid(sys);
  if (!sid) return { ok: false, message: "Could not read this Windows user's SID (whoami)." };
  const plan = helperInstallPlan();
  const prepared = await plan.prepare(sys, kind);
  if (!prepared.ok) return prepared;
  const payloads: StagedPayload[] = [];
  let script: StagedPayload;
  if (kind === "install") {
    payloads.push(stage(sys, "helper.ps1", "HelperBytes", plan.buildHelper(sid)));
    payloads.push(...prepared.payloads);
    script = stage(sys, "install.ps1", "ScriptBytes",
      buildInstallScript({ userSid: sid, actions: plan.actions, extraSteps: plan.installSteps }));
  } else {
    payloads.push(...prepared.payloads);
    script = stage(sys, "uninstall.ps1", "ScriptBytes",
      buildUninstallScript({ actions: plan.actions, extraSteps: plan.uninstallSteps }));
  }
  const launcher = buildElevationLauncher(powershellExe(), encodePowerShell(buildBootstrap(payloads, script)));
  const r = await sys.run([powershellExe(), "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(launcher)], ELEVATION_TIMEOUT_MS);
  return explainExit(sys, r.code);
}

/** Starts an install or uninstall in the background; the caller polls `getHelperStatus`. */
export function startHelperJob(kind: "install" | "uninstall"): HelperJob {
  const sys = helperSystem();
  if (sys.platform !== "win32") throw new Error("The headless helper is only for Windows hosts.");
  if (job?.state === "running") return job;
  const current: HelperJob = { kind, state: "running", message: null };
  job = current;
  log.info(`headless helper ${kind} requested`);
  void elevate(sys, kind)
    .catch((e): HelperRunResult => ({ ok: false, message: (e as Error).message }))
    .then((r) => {
      current.state = r.ok ? "done" : "error";
      current.message = r.message;
      cachedStatus = null;
      log.info(`headless helper ${kind} ${current.state}: ${r.message}`);
    });
  return current;
}

/** The helper's answer to the run of `action` started at `started`, once it lands, or null when
 *  `waitMs` passes first. */
async function awaitAnswer(sys: HelperSystem, action: PpmHelperAction, started: number, waitMs: number): Promise<HelperRunResult | null> {
  const deadline = sys.now() + waitMs;
  // The helper stamps its answer in UTC; allow for a clock a little behind PPM's.
  while (sys.now() < deadline) {
    await sys.sleep(500);
    const last = parseJson<{ action?: string; ok?: boolean; message?: string; at?: string; startedAt?: string; ms?: number; lockMs?: number }>(
      sys.readText(helperPaths().lastRun));
    const at = last?.at ? Date.parse(last.at) : NaN;
    if (last?.action === action && at >= started - 2000) {
      cachedStatus = null;
      // When the script itself started, and how long its run took (written by helpers since v3),
      // so a slow answer says whether Windows was slow to start it or the work itself was slow.
      const startDelay = last.startedAt ? Date.parse(last.startedAt) - started : NaN;
      const timing = Number.isFinite(startDelay) ? ` (started ${startDelay} ms after the request, ran ${last.ms} ms, lock wait ${last.lockMs} ms)` : "";
      log.info(`headless helper ${action}: ok=${!!last.ok} ${last.message ?? ""}${timing}`);
      return { ok: !!last.ok, message: last.message ?? "" };
    }
  }
  return null;
}

/** Background watches for answers that came after the request gave up, by action. */
const lateWatches = new Map<PpmHelperAction, Promise<HelperRunResult | null>>();

async function runOnce(sys: HelperSystem, action: PpmHelperAction): Promise<HelperRunResult> {
  const status = await getHelperStatus(true);
  if (!status.usable) return { ok: false, message: "The headless helper is not set up for this Windows user." };
  const started = sys.now();
  const r = await sys.run([schtasksExe(), "/run", "/tn", taskName(action)], RUN_TIMEOUT_MS);
  if (r.code !== 0) return { ok: false, message: `Could not start the helper task: ${(r.stderr || r.stdout).trim()}` };
  const answer = await awaitAnswer(sys, action, started, ANSWER_WAIT_MS);
  if (answer) return answer;
  // Not a failure: the task is running and may still do what it was asked. Keep watching, so the
  // answer is logged and a caller that must act on it (the display lease) still can.
  log.warn(`headless helper ${action}: no answer within ${ANSWER_WAIT_MS / 1000} s; still watching`);
  lateWatches.set(action, awaitAnswer(sys, action, started, LATE_ANSWER_MS).then((late) => {
    if (!late) log.warn(`headless helper ${action}: never answered`);
    return late;
  }));
  return { ok: false, pending: true, message: PENDING_MESSAGE };
}

/** The late answer of the last `action` that came back `pending`: resolves when the helper
 *  answers, or null if it never does. Null at once when nothing is being watched. */
export function lateHelperAnswer(action: PpmHelperAction): Promise<HelperRunResult | null> {
  return lateWatches.get(action) ?? Promise.resolve(null);
}

/** Runs one fixed task. One at a time: a second request waits for the first's answer. Never
 *  `Rescue`: that one is started by its own timer only. */
export function runHelperAction(action: PpmHelperAction): Promise<HelperRunResult> {
  const sys = helperSystem();
  const previous = running ?? Promise.resolve({ ok: true, message: "" });
  const next = previous.then(() => runOnce(sys, action), () => runOnce(sys, action));
  running = next;
  return next;
}
