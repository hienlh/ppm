import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { CODE_BLOCK_MAX_CHARS, CODE_BLOCK_RUN_TIMEOUT_MS, runCodeBlock } from "../../services/code-block-run.ts";
import { createLogger } from "../../services/logger.ts";

/** Never logs the command: a code block can hold a password or a token. */
const log = createLogger("code-block-run");

type Env = { Variables: { projectPath: string; projectName: string } };

/**
 * `POST /api/project/:projectName/shell/run` — the Run button on a chat's shell code block.
 * Body `{ command }`; answers what the command printed and how it ended. Closing the request
 * (the Stop button, a closed tab) kills the run.
 */
export const codeBlockRunRoutes = new Hono<Env>();

codeBlockRunRoutes.post("/run", async (c) => {
  const body = await c.req.json().catch(() => null) as { command?: unknown } | null;
  const command = typeof body?.command === "string" ? body.command.trim() : "";
  if (!command) return c.json(err("Nothing to run"), 400);
  if (command.length > CODE_BLOCK_MAX_CHARS) return c.json(err(`Too long to run (over ${CODE_BLOCK_MAX_CHARS} characters)`), 400);
  // The run can outlast Bun.serve's 10 s idle timeout; it ends on its own limit or a closed request.
  (c.env as { timeout?: (request: Request, seconds: number) => void } | undefined)?.timeout?.(c.req.raw, CODE_BLOCK_RUN_TIMEOUT_MS / 1000 + 30);
  const r = await runCodeBlock(command, c.get("projectPath"), c.req.raw.signal);
  log.info(`project=${c.get("projectName")} chars=${command.length} exit=${r.code ?? "none"}${r.timedOut ? " timedOut" : ""}${r.aborted ? " stopped" : ""} durationMs=${r.durationMs}`);
  return c.json(ok({ output: r.output, exitCode: r.code, timedOut: r.timedOut, stopped: r.aborted, durationMs: r.durationMs }));
});
