/**
 * Codex one-shot: one short-lived app-server per call, bound to the account's CODEX_HOME,
 * running one ephemeral thread (read-only sandbox, approvals never) and one turn, read until
 * `turn/completed`. The app-server is closed — its process killed — on every way out: an
 * answer, a failure, the deadline and a cancel. Killing it is what stops a cancelled turn
 * from spending; `turn/interrupt` is sent first but not waited for.
 *
 * A schema goes in as the turn's `outputSchema`. A turn refused for that schema runs once
 * more without it, so the caller's prompt-and-validate path still gets a chance.
 * Web search is the thread's `config.web_search = "live"`.
 */
import { CodexJsonRpcClient, CONTROL_REQUEST_TIMEOUT_MS, type CloseHandler, type NotificationHandler, type ServerRequestHandler } from "./codex-jsonrpc-client.ts";
import { codexOneShotThreadParams, codexOneShotTurnParams, CodexOneShotCollector, isSchemaRefusal, type CodexTurnEnd } from "./codex-one-shot-turn.ts";
import { isCodexUsageLimit } from "./codex-usage-limit.ts";
import { redactTruncate } from "./codex-redact.ts";
import { OneShotError } from "../one-shot-error.ts";
import type { OneShotInput, OneShotResult } from "../../types/chat.ts";

const CLIENT_INFO = { name: "ppm", title: "PPM", version: "0.0.0" };
const CAPABILITIES = { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null };
export const CODEX_ONE_SHOT_DEFAULT_TIMEOUT_MS = 180_000;

/** The part of `CodexJsonRpcClient` a one-shot uses; tests pass a fake app-server. */
export interface OneShotRpcClient {
  start(opts: { cwd?: string; codexHome?: string; purpose?: "control" }): void;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotification(fn: NotificationHandler): void;
  onServerRequest(fn: ServerRequestHandler): void;
  onClose(fn: CloseHandler): void;
  respondError(id: number | string, message: string): void;
  close(): void;
}

export interface CodexOneShotContext {
  cwd: string;
  /** The account's CODEX_HOME; absent means the machine's own ~/.codex login. */
  codexHome?: string;
  createClient?: () => OneShotRpcClient;
}

export async function codexCompleteOnce(input: OneShotInput, ctx: CodexOneShotContext): Promise<OneShotResult> {
  if (input.signal?.aborted) throw new OneShotError("ABORTED", "The call was cancelled");
  const client = ctx.createClient?.() ?? new CodexJsonRpcClient();
  const collector = new CodexOneShotCollector();
  let threadId: string | null = null;
  let turnRunning = false;
  let fail!: (error: OneShotError) => void;
  // Settles only by failing: every wait below races it, so a cancel or the deadline ends the
  // call at once instead of after the request the call happens to be waiting on.
  const failed = new Promise<never>((_, reject) => { fail = reject; });
  failed.catch(() => {});
  const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, failed]);
  const usage = () => collector.tokens();
  const timer = setTimeout(
    () => fail(new OneShotError("TIMEOUT", "Codex took too long to answer", { usage: usage() })),
    input.timeoutMs ?? CODEX_ONE_SHOT_DEFAULT_TIMEOUT_MS,
  );
  const onAbort = () => fail(new OneShotError("ABORTED", "The call was cancelled", { usage: usage() }));
  input.signal?.addEventListener("abort", onAbort, { once: true });

  const runTurn = async (outputSchema: Record<string, unknown> | undefined): Promise<CodexTurnEnd> => {
    collector.resetAnswer();
    const ended = new Promise<CodexTurnEnd>((resolve) => collector.awaitEnd(resolve));
    turnRunning = true;
    const res = await race(client.request<{ turn?: { id?: string } }>(
      "turn/start", codexOneShotTurnParams(threadId!, input, outputSchema), CONTROL_REQUEST_TIMEOUT_MS,
    ));
    if (!collector.turnId && typeof res?.turn?.id === "string") collector.turnId = res.turn.id;
    const end = await race(ended);
    turnRunning = false;
    return end;
  };

  try {
    client.onNotification((notif) => collector.handle(notif));
    // Approvals are "never", so no request should arrive; anything that does is refused.
    client.onServerRequest((req) => client.respondError(req.id, "Not available in a one-shot call"));
    client.onClose(() => fail(new OneShotError("PROVIDER_ERROR", "codex subprocess exited", { usage: usage() })));
    client.start({ cwd: ctx.cwd, ...(ctx.codexHome ? { codexHome: ctx.codexHome } : {}), purpose: "control" });
    await race(client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES }, CONTROL_REQUEST_TIMEOUT_MS));
    client.notify("initialized");
    const thread = await race(client.request<{ thread?: { id?: string } }>(
      "thread/start", codexOneShotThreadParams({ ...input, cwd: ctx.cwd }), CONTROL_REQUEST_TIMEOUT_MS,
    ));
    threadId = typeof thread?.thread?.id === "string" ? thread.thread.id : null;
    if (!threadId) throw new OneShotError("PROVIDER_ERROR", "Codex started no thread");

    let end = await runTurn(input.jsonSchema);
    if (end.status !== "completed" && input.jsonSchema && isSchemaRefusal(end.error ?? "")) {
      end = await runTurn(undefined);
    }
    if (end.status !== "completed") {
      const reason = redactTruncate(end.error || `turn ${end.status}`, 300);
      const code = isCodexUsageLimit(reason) ? "RATE_LIMITED" : "PROVIDER_ERROR";
      throw new OneShotError(code, `Codex did not answer: ${reason}`, { usage: usage() });
    }
    return { text: collector.answer(), ...usage() };
  } catch (error) {
    if (error instanceof OneShotError) {
      if (!error.usage) error.usage = usage();
      throw error;
    }
    const reason = (error as Error)?.message ?? String(error);
    throw new OneShotError(isCodexUsageLimit(reason) ? "RATE_LIMITED" : "PROVIDER_ERROR",
      `Codex did not answer: ${redactTruncate(reason, 300)}`, { usage: usage() });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    if (turnRunning && threadId && collector.turnId) {
      client.request("turn/interrupt", { threadId, turnId: collector.turnId }).catch(() => {});
    }
    client.close();
  }
}
