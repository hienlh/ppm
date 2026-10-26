import { EXIT_CODE_FOR, isExecuteErrorCode, type ExecuteSuccess } from "../../shared/extension-command-execute.ts";
import { HttpError, SERVER_DOWN_MESSAGE, ServerDownError, callServer } from "./server-client.ts";

/**
 * Run a declared extension command on the running server and print its result: the shared
 * half of `ppm ext run` and every `ppm <alias>` an extension contributes.
 *
 * stdout carries the result and nothing else, so `--json` output can be piped; every error goes
 * to stderr. Exit codes: 0 success, 1 the server is not running or refused the token, 2 the
 * command never ran (not found, not active, host not ready, bad request), 3 it ran and failed or
 * timed out.
 */

export type PrintMode = "auto" | "json";

export interface CommandRunIo {
  stdout(text: string): Promise<void>;
  stderr(text: string): void;
}

export type CallServer = typeof callServer;

const writeOut = (text: string) => new Promise<void>((done) => {
  if (!text) return done();
  process.stdout.write(text, () => done());
});

const realIo: CommandRunIo = {
  stdout: writeOut,
  stderr: (text) => { process.stderr.write(text.endsWith("\n") ? text : `${text}\n`); },
};

/** What `auto` prints: a string as it is, any other value as indented JSON, `null` as nothing. */
export function formatCommandResult(result: unknown, mode: PrintMode): string {
  if (mode === "json") return `${JSON.stringify(result ?? null)}\n`;
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result.endsWith("\n") ? result : `${result}\n`;
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** Runs the command and answers the exit code; the caller exits with it. */
export async function runExtensionCommand(
  command: string,
  args: unknown[],
  opts: { printMode: PrintMode; timeoutMs: number },
  call: CallServer = callServer,
  io: CommandRunIo = realIo,
): Promise<number> {
  try {
    const data = await call<ExecuteSuccess>(
      "POST", "/api/extensions/commands/execute",
      { command, args, timeoutMs: opts.timeoutMs },
      { timeoutMs: opts.timeoutMs },
    );
    await io.stdout(formatCommandResult(data.result, opts.printMode));
    return 0;
  } catch (e) {
    if (e instanceof ServerDownError) {
      io.stderr(SERVER_DOWN_MESSAGE);
      return 1;
    }
    if (e instanceof HttpError) {
      if (e.status === 401) {
        io.stderr("PPM refused the CLI's token (auth.token changed?)");
        return 1;
      }
      io.stderr(e.message);
      if (isExecuteErrorCode(e.code)) return EXIT_CODE_FOR[e.code];
      // Status 0: the server took the request and the CLI's own wait ran out, which is the
      // command timing out (the server was there: the health check answered), not a server down.
      return e.status === 0 ? EXIT_CODE_FOR.TIMEOUT : 2;
    }
    io.stderr(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
