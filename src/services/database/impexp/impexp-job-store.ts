/**
 * The Import/Export jobs the server is running, or ran within the hour, kept in memory: each a
 * list of rows that are Queued until their turn, then Running and Done, Error or Stopped, with the
 * messages and files the job made on the way. The tab reads one by its id; a restart forgets them
 * all, and startup removes the files they left (`wipeImpExpFiles`).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  ImpExpFileFormat, ImpExpItemStatus, ImpExpJobState, ImpExpJobStatus, ImpExpMessage, ImpExpMessageLevel, ImpExpOutputFile,
} from "../../../shared/db-impexp.ts";
import { IMPEXP_FILE_TTL_MS, exportsDir, makeDir, removePath } from "./impexp-files.ts";

/**
 * Jobs running at once. Each holds a connection to its database, and an export a batch of rows,
 * so a script starting jobs in a loop cannot use up the database's connections or PPM's memory.
 */
export const MAX_RUNNING_JOBS = 4;

/** Messages a job keeps; past them it only counts. */
export const MAX_JOB_MESSAGES = 2_000;

/** How often finished jobs past their hour are let go. */
const SWEEP_EVERY_MS = 5 * 60 * 1000;

export class TooManyJobsError extends Error {
  constructor() {
    super(`${MAX_RUNNING_JOBS} import/export jobs are already running. Run again once one has finished.`);
  }
}

/** A file a job wrote: what the browser downloads it as, and where the server keeps it. */
export interface JobFile extends ImpExpOutputFile {
  path: string;
  /** What it holds, for the download's Content-Type. */
  format: ImpExpFileFormat | "zip";
}

export interface ImpExpJob {
  readonly id: string;
  readonly kind: "export" | "import";
  state: ImpExpJobState;
  readonly items: ImpExpItemStatus[];
  readonly messages: ImpExpMessage[];
  /** Messages past `MAX_JOB_MESSAGES`, counted rather than kept. */
  dropped: number;
  readonly files: JobFile[];
  /** The export's own folder, which its files are written into; null for an import. */
  readonly dir: string | null;
  readonly startedAt: number;
  endedAt: number | null;
  /** Stop: every read and write the job makes listens to it. */
  readonly abort: AbortController;
}

const jobs = new Map<string, ImpExpJob>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function runningJobs(): number {
  let n = 0;
  for (const job of jobs.values()) if (job.state === "running") n++;
  return n;
}

/**
 * A new job over `items`, every one of them Queued; throws `TooManyJobsError` when as many as may
 * run already are. The slot is taken before anything is awaited, so two requests at once cannot
 * both take the last one.
 */
export async function createJob(kind: "export" | "import", items: readonly { source: string; target: string }[]): Promise<ImpExpJob> {
  if (runningJobs() >= MAX_RUNNING_JOBS) throw new TooManyJobsError();
  const id = randomBytes(16).toString("base64url");
  const job: ImpExpJob = {
    id,
    kind,
    state: "running",
    items: items.map((i) => ({ source: i.source, target: i.target, state: "queued", rowsRead: 0, rowsWritten: 0 })),
    messages: [],
    dropped: 0,
    files: [],
    dir: kind === "export" ? join(exportsDir(), id) : null,
    startedAt: Date.now(),
    endedAt: null,
    abort: new AbortController(),
  };
  jobs.set(id, job);
  if (job.dir) {
    try {
      await makeDir(job.dir);
    } catch (e) {
      jobs.delete(id);
      throw e;
    }
  }
  startSweeper();
  return job;
}

export function getJob(id: string): ImpExpJob | null {
  return jobs.get(id) ?? null;
}

export function addMessage(job: ImpExpJob, level: ImpExpMessageLevel, text: string): void {
  if (job.messages.length >= MAX_JOB_MESSAGES) {
    job.dropped++;
    return;
  }
  job.messages.push({ level, text, time: Date.now() });
}

/** The job has ended; its files are kept for the hour from now. */
export function finishJob(job: ImpExpJob, state: Exclude<ImpExpJobState, "running">): void {
  if (job.state !== "running") return;
  if (job.dropped) addMessageAnyway(job, "warning", `${job.dropped.toLocaleString("en-US")} more messages were left out`);
  job.state = state;
  job.endedAt = Date.now();
}

function addMessageAnyway(job: ImpExpJob, level: ImpExpMessageLevel, text: string): void {
  job.messages.push({ level, text, time: Date.now() });
}

/** Stop a running job: what it is reading or writing is cancelled, and what it has not begun stays Queued. */
export function stopJob(job: ImpExpJob): void {
  if (job.state === "running") job.abort.abort();
}

/** The job as the tab reads it, with the messages from the `since`-th on. */
export function jobStatus(job: ImpExpJob, since = 0): ImpExpJobStatus {
  const from = Math.max(0, Math.min(Math.floor(since) || 0, job.messages.length));
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    items: job.items.map((i) => ({ ...i })),
    messages: job.messages.slice(from),
    messageCount: job.messages.length,
    files: job.files.map(({ name, size }) => ({ name, size })),
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  };
}

/** The file of `job` the browser knows by `name`. */
export function jobFile(job: ImpExpJob, name: string): JobFile | null {
  return job.files.find((f) => f.name === name) ?? null;
}

/** Let go of the jobs that ended more than an hour before `now`, and their files. */
export async function sweepJobs(now = Date.now()): Promise<void> {
  const expired = [...jobs.values()].filter((j) => j.endedAt !== null && now - j.endedAt >= IMPEXP_FILE_TTL_MS);
  for (const job of expired) jobs.delete(job.id);
  await Promise.all(expired.map((j) => (j.dir ? removePath(j.dir) : Promise.resolve())));
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => { void sweepJobs(); }, SWEEP_EVERY_MS);
  sweeper.unref?.();
}

/** Stop every running job and forget them all (shutdown, tests). */
export function resetJobs(): void {
  for (const job of jobs.values()) stopJob(job);
  jobs.clear();
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
