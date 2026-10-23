import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { buildClaudeOneShotOptions, claudeCompleteOnce, type ClaudeOneShotContext } from "../../../src/providers/claude-complete-once.ts";
import { getConfigValue, openTestDb, setDb } from "../../../src/services/db.service.ts";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import { accountService } from "../../../src/services/account.service.ts";
import type { OneShotInput } from "../../../src/types/chat.ts";

const keyPath = resolve(tmpdir(), `ppm-test-claude-one-shot-${Date.now()}.key`);
setKeyPath(keyPath);
beforeEach(() => setDb(openTestDb()));
afterEach(() => { setDb(openTestDb()); if (existsSync(keyPath)) unlinkSync(keyPath); });

const base: OneShotInput = { prompt: "p", systemPrompt: "s", model: "claude-haiku-4-5" };
const run = { cwd: "/ppm/one-shot", env: { A: "1" }, abortController: new AbortController() };
const ctx = { useNode: false };
const SCHEMA = { type: "object", properties: { a: { type: "integer" } } };

describe("buildClaudeOneShotOptions", () => {
  it("keeps a plain call tool-less, single-turn and settings-free", () => {
    const o = buildClaudeOneShotOptions(base, ctx, run) as Record<string, unknown>;
    expect(o.tools).toEqual([]);
    expect(o.maxTurns).toBe(1);
    expect(o.allowedTools).toBeUndefined();
    expect(o.outputFormat).toBeUndefined();
    expect(o.settingSources).toEqual([]);
    expect(o.persistSession).toBe(false);
    expect(o.cwd).toBe("/ppm/one-shot");
    expect(o.systemPrompt).toBe("s");
    expect(o.env).toEqual({ A: "1" });
    expect(o.abortController).toBe(run.abortController);
  });

  it("asks for structured output with room for its tool round trip", () => {
    const o = buildClaudeOneShotOptions({ ...base, jsonSchema: SCHEMA }, ctx, run) as Record<string, unknown>;
    expect(o.outputFormat).toEqual({ type: "json_schema", schema: SCHEMA });
    expect(o.tools).toEqual([]);
    expect(o.maxTurns).toBe(3);
  });

  it("allows exactly the two web tools, for up to 12 turns", () => {
    const o = buildClaudeOneShotOptions({ ...base, webSearch: true, jsonSchema: SCHEMA }, ctx, run) as Record<string, unknown>;
    expect(o.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(o.allowedTools).toEqual(["WebSearch", "WebFetch"]);
    expect(o.maxTurns).toBe(12);
    expect(o.outputFormat).toEqual({ type: "json_schema", schema: SCHEMA });
  });

  it("starts the CLI the way the provider says", () => {
    const o = buildClaudeOneShotOptions(base, { useNode: true, cliExecutablePath: "/bin/claude.js" }, run) as Record<string, unknown>;
    expect(o.executable).toBe("node");
    expect(o.pathToClaudeCodeExecutable).toBe("/bin/claude.js");
  });
});

type Msg = Record<string, unknown>;
const assistant = (id: string, input: number, output: number): Msg => ({ type: "assistant", message: { id, usage: { input_tokens: input, output_tokens: output } } });
const success = (extra: Msg = {}): Msg => ({ type: "result", subtype: "success", is_error: false, result: "answer", usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 }, ...extra });

/** A fake `query` that yields `messages`, then waits for an abort when `hang` is set. */
function fakeQuery(messages: Msg[], opts: { hang?: boolean } = {}) {
  const seen: { options?: Record<string, unknown> } = {};
  const runQuery = (({ options }: { options: Record<string, unknown> }) => {
    seen.options = options;
    const abort = (options.abortController as AbortController).signal;
    return (async function* () {
      for (const m of messages) yield m;
      if (opts.hang) {
        await new Promise((_, reject) => abort.addEventListener("abort", () => reject(new Error("aborted by user"))));
      }
    })();
  }) as unknown as ClaudeOneShotContext["runQuery"];
  return { runQuery, seen };
}

const envFor: string[] = [];
const oneShotCtx = (runQuery: ClaudeOneShotContext["runQuery"]): ClaudeOneShotContext => ({
  useNode: false, runQuery, buildEnv: (account) => { envFor.push(account?.id ?? "ambient"); return {}; },
});

describe("claudeCompleteOnce", () => {
  it("returns the text, the native structured answer and the tokens", async () => {
    const { runQuery } = fakeQuery([assistant("m1", 5, 1), success({ structured_output: { a: 1 } })]);
    expect(await claudeCompleteOnce({ ...base, jsonSchema: SCHEMA }, oneShotCtx(runQuery)))
      .toEqual({ text: "answer", structured: { a: 1 }, inputTokens: 12, outputTokens: 4 });
  });

  it("runs on a named account without moving the round-robin cursor", async () => {
    const a = accountService.add({ email: "a@x", accessToken: "a-a", refreshToken: "r-a", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    accountService.add({ email: "b@x", accessToken: "a-b", refreshToken: "r-b", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const cursor = getConfigValue("account_round_robin_last");
    const { runQuery } = fakeQuery([success()]);
    envFor.length = 0;
    const result = await claudeCompleteOnce({ ...base, accountId: a.id }, oneShotCtx(runQuery));
    expect(result.accountId).toBe(a.id);
    expect(envFor).toEqual([a.id]);
    expect(getConfigValue("account_round_robin_last")).toBe(cursor);
    expect((await claudeCompleteOnce({ ...base, accountId: "gone" }, oneShotCtx(runQuery)).catch((e) => e)).code).toBe("NO_ACCOUNT");
  });

  it("an abort stops the query itself and reports what was spent", async () => {
    const { runQuery, seen } = fakeQuery([assistant("m1", 30, 3), assistant("m1", 30, 3), assistant("m2", 8, 1)], { hang: true });
    const controller = new AbortController();
    const pending = claudeCompleteOnce({ ...base, signal: controller.signal }, oneShotCtx(runQuery)).catch((e) => e);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const error = await pending;
    expect((seen.options!.abortController as AbortController).signal.aborted).toBe(true);
    expect([error.code, error.name]).toEqual(["ABORTED", "AbortError"]);
    // A response's usage repeated on each of its content blocks is counted once.
    expect(error.usage).toEqual({ inputTokens: 38, outputTokens: 4 });
  });

  it("times out with the message the Logs window has always shown", async () => {
    const { runQuery, seen } = fakeQuery([], { hang: true });
    const error = await claudeCompleteOnce({ ...base, timeoutMs: 20 }, oneShotCtx(runQuery)).catch((e) => e);
    expect([error.code, error.message]).toEqual(["TIMEOUT", "Claude took too long to answer"]);
    expect((seen.options!.abortController as AbortController).signal.aborted).toBe(true);
  });

  it("names a rate limit and an exhausted structured-output retry", async () => {
    const limited = fakeQuery([{ type: "assistant", error: "rate_limit", message: {} }, { type: "result", subtype: "error_during_execution", is_error: true }]);
    expect((await claudeCompleteOnce(base, oneShotCtx(limited.runQuery)).catch((e) => e)).code).toBe("RATE_LIMITED");
    const bad = fakeQuery([{ type: "result", subtype: "error_max_structured_output_retries", is_error: true }]);
    expect((await claudeCompleteOnce(base, oneShotCtx(bad.runQuery)).catch((e) => e)).code).toBe("BAD_JSON");
    const aborted = new AbortController();
    aborted.abort();
    expect((await claudeCompleteOnce({ ...base, signal: aborted.signal }, oneShotCtx(bad.runQuery)).catch((e) => e)).code).toBe("ABORTED");
  });
});
