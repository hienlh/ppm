/**
 * The effort a chat's turns really run at, kept beside the pick.
 *
 * PPM starts the CLI with the picked `--effort`, but `CLAUDE_CODE_EFFORT_LEVEL` (in the
 * environment or a settings file's `env`), a `maxEffortLevel` cap, an organization limit and the
 * model itself all outrank it there. So the session's CLI is asked at the start of every turn —
 * a settings file edited since the last one shows up there too — and its answer goes to the
 * clients. Before any turn has asked, what the settings files say stands in.
 */
import { effortInEffect, effortSettingPlace, type EffortStatus } from "../../shared/effort-status.ts";

export interface EffortStatusSession {
  providerId: string;
  projectPath?: string;
  /** The CLI's last answer for this session. */
  effortStatus?: EffortStatus;
}

export interface EffortStatusProvider {
  readEffortStatus?(sessionId: string): Promise<EffortStatus | null>;
  estimateEffortStatus?(projectPath: string | undefined, model?: string): EffortStatus;
}

/** What a greeting carries: the CLI's answer, else the settings files; null for a provider nothing overrides. */
export function sessionEffortStatus(
  provider: EffortStatusProvider | undefined,
  session: EffortStatusSession,
  model: string | undefined,
): EffortStatus | null {
  return session.effortStatus ?? provider?.estimateEffortStatus?.(session.projectPath, model) ?? null;
}

/** The session log's line for a turn whose effort is not the one it was started with. */
export function effortOverrideLogLine(status: EffortStatus): string | null {
  const { observed } = status;
  if (!observed?.requested) return null;
  const { level, reason } = effortInEffect(observed.requested, status);
  if (!reason) return null;
  const by = reason === "env" && status.env
    ? `CLAUDE_CODE_EFFORT_LEVEL=${status.env.value} in ${effortSettingPlace(status.env)}`
    : reason === "cap" && status.cap
      ? `maxEffortLevel ${status.cap.value} in ${effortSettingPlace(status.cap)}`
      : `what ${observed.model ?? "the model"} allows`;
  return `Effort ${observed.requested} was picked; Claude Code sends ${level ?? "no effort"} (${by})`;
}

/**
 * Ask the session's CLI at a turn's start, and tell the clients when its answer changed. Never
 * rejects: it runs unawaited beside the turn, where a rejection would reach the server's
 * fatal-error handler for what is only a label.
 */
export async function refreshEffortStatus(p: {
  sessionId: string;
  session: EffortStatusSession;
  provider: EffortStatusProvider | undefined;
  /** False once the session's entry was replaced while the CLI was answering. */
  isCurrent: () => boolean;
  broadcast: (event: unknown) => void;
  log: (line: string) => void;
}): Promise<void> {
  try {
    const status = await p.provider?.readEffortStatus?.(p.sessionId);
    if (!status || !p.isCurrent()) return;
    const before = p.session.effortStatus;
    p.session.effortStatus = status;
    if (before && JSON.stringify(before) === JSON.stringify(status)) return;
    p.broadcast({ type: "effort_status", status });
    const line = effortOverrideLogLine(status);
    if (line) p.log(line);
  } catch {
    // The status stays as it was; the next turn asks again.
  }
}
