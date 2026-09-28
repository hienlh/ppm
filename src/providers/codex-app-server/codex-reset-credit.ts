/**
 * Spend one of Codex's free rate-limit resets, through the app-server's own
 * `account/rateLimitResetCredit/consume` (codex ≥ 0.157).
 *
 * Deliberately thin: one short-lived app-server on the account's CODEX_HOME, one call, the
 * outcome back. Whether a reset *should* be spent is decided by the caller
 * (`codex-reset-credit.service.ts`), never here.
 */
import { CodexJsonRpcClient, CONTROL_REQUEST_TIMEOUT_MS } from "./codex-jsonrpc-client.ts";

const CLIENT_INFO = { name: "ppm", title: "PPM", version: "0.0.0" };
const CAPABILITIES = { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null };

/**
 * What Codex did. Straight from its protocol: `nothingToReset` means no window was refreshed and
 * the credit is kept (OpenAI: "If there is nothing eligible to reset, the benefit remains
 * available"); `alreadyRedeemed` answers a retry of an attempt that already went through.
 */
export type ResetCreditOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

const OUTCOMES = new Set<ResetCreditOutcome>(["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]);

/**
 * @param idempotencyKey one logical attempt; Codex treats a repeat of the same key as the same
 *   attempt, so a retried request cannot spend a second credit.
 * @param creditId which credit to spend; omitted lets Codex pick the next available one.
 */
export async function consumeCodexResetCredit(
  codexHome: string,
  idempotencyKey: string,
  creditId?: string,
): Promise<ResetCreditOutcome> {
  const client = new CodexJsonRpcClient();
  try {
    client.start({ cwd: process.cwd(), codexHome });
    await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES }, CONTROL_REQUEST_TIMEOUT_MS);
    client.notify("initialized");
    const res = await client.request<{ outcome?: string }>(
      "account/rateLimitResetCredit/consume",
      { idempotencyKey, ...(creditId ? { creditId } : {}) },
      CONTROL_REQUEST_TIMEOUT_MS,
    );
    const outcome = res?.outcome as ResetCreditOutcome | undefined;
    if (!outcome || !OUTCOMES.has(outcome)) throw new Error(`Codex answered the reset with an unknown outcome: ${String(res?.outcome)}`);
    return outcome;
  } finally {
    client.close();
  }
}
