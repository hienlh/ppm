/**
 * Codex one-shot: one short-lived app-server per call, bound to the account's CODEX_HOME,
 * running one ephemeral thread (read-only sandbox, approvals never, shell and subagents off)
 * and one turn, read until `turn/completed`. On every way out — an answer, a failure, the
 * deadline and a cancel — the app-server's whole process tree is killed. Killing only the
 * `bun x` wrapper is not enough: on Windows that leaves the native `codex.exe` it started
 * running, mid-turn and still spending. `turn/interrupt` is sent first but not waited for.
 *
 * A schema goes in as the turn's `outputSchema`. A turn refused for that schema runs once
 * more without it, on a fresh thread so the refused prompt is not paid for twice, giving the
 * caller's prompt-and-validate path a chance. Web search is the thread's
 * `config.web_search = "live"`.
 *
 * What the call learns about its account is recorded as a chat records it: a signed-out login
 * ends the call at codex's first retry notice and benches the account, a usage limit parks it,
 * and an answer clears a sign-out mark.
 */
import { CodexJsonRpcClient, CONTROL_REQUEST_TIMEOUT_MS, type CloseHandler, type NotificationHandler, type ServerRequestHandler } from "./codex-jsonrpc-client.ts";
import { codexOneShotThreadParams, codexOneShotTurnParams, CodexOneShotCollector, isSchemaRefusal, type CodexTurnEnd } from "./codex-one-shot-turn.ts";
import { codexAccountProblemError, recordCodexAccountAnswered, recordCodexAccountProblem } from "./codex-one-shot-account-health.ts";
import { isCodexUsageLimit } from "./codex-usage-limit.ts";
import { redactTruncate } from "./codex-redact.ts";
import { planAssistantCodexMcp } from "./codex-assistant-mcp-guard.ts";
import { killProcessTree } from "../../services/windows-process-tree.ts";
import { OneShotError } from "../one-shot-error.ts";
import type { OneShotInput, OneShotResult } from "../../types/chat.ts";

const CLIENT_INFO = { name: "ppm", title: "PPM", version: "0.0.0" };
const CAPABILITIES = { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null };
export const CODEX_ONE_SHOT_DEFAULT_TIMEOUT_MS = 180_000;

/** The part of `CodexJsonRpcClient` a one-shot uses; tests pass a fake app-server. */
export interface OneShotRpcClient {
  /** The spawned process, whose tree is killed when the call ends. */
  readonly pid?: number;
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
  /** The managed account behind `codexHome`, whose health the call records. */
  accountId?: string;
  createClient?: () => OneShotRpcClient;
}

/** Stop the app-server and everything under it. The tree is walked while its root still lives. */
function killAppServer(client: OneShotRpcClient): void {
  const pid = client.pid;
  if (pid) { try { killProcessTree(pid); } catch { /* already gone */ } }
  client.close();
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
  collector.onAccountProblem = (problem) => {
    recordCodexAccountProblem(ctx.accountId, problem);
    fail(codexAccountProblemError(problem, usage()));
  };

  // The user's own MCP servers from their config.toml, switched off for the call the way a PPM
  // Assistant session switches them off: nothing in a one-shot may reach them, and a config that
  // cannot be read refuses the call rather than run with them.
  let disableMcpServers: string[] = [];
  const startThread = async (): Promise<string> => {
    const thread = await race(client.request<{ thread?: { id?: string } }>(
      "thread/start", codexOneShotThreadParams({ ...input, cwd: ctx.cwd, disableMcpServers }), CONTROL_REQUEST_TIMEOUT_MS,
    ));
    const id = typeof thread?.thread?.id === "string" ? thread.thread.id : null;
    if (!id) throw new OneShotError("PROVIDER_ERROR", "Codex started no thread");
    collector.follow(id);
    return id;
  };

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
    try {
      disableMcpServers = await race(planAssistantCodexMcp(client, ctx.cwd, { ownServer: false, privateNames: [] }));
    } catch (e) {
      if (e instanceof OneShotError) throw e;
      throw new OneShotError(
        "PROVIDER_ERROR",
        "Codex could not report its MCP configuration, so your own MCP servers could not be kept out of this call. "
          + "Update Codex (npm i -g @openai/codex) and try again.",
        { usage: usage() },
      );
    }
    threadId = await startThread();

    let end = await runTurn(input.jsonSchema);
    if (end.status !== "completed" && input.jsonSchema && isSchemaRefusal(end.error ?? "")) {
      threadId = await startThread();
      end = await runTurn(undefined);
    }
    if (end.status !== "completed") {
      const usageLimited = isCodexUsageLimit(end.error ?? "");
      if (usageLimited) recordCodexAccountProblem(ctx.accountId, { kind: "usage", reason: end.error! });
      const reason = redactTruncate(end.error || `turn ${end.status}`, 300);
      throw new OneShotError(usageLimited ? "RATE_LIMITED" : "PROVIDER_ERROR", `Codex did not answer: ${reason}`, { usage: usage() });
    }
    recordCodexAccountAnswered(ctx.accountId);
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
    collector.onAccountProblem = null;
    if (turnRunning && threadId && collector.turnId) {
      client.request("turn/interrupt", { threadId, turnId: collector.turnId }).catch(() => {});
    }
    killAppServer(client);
  }
}
