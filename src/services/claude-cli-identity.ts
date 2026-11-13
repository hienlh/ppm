/**
 * The headers Claude Code's own CLI sends to `api.anthropic.com/api/...`, for the two calls
 * Anthropic answers only to it: the usage read that lists the account's free limit resets
 * (`?cedar_ember=1`) and the claim that spends one.
 *
 * Anthropic decides who is offered limit resets by the asking app, not the account: the same
 * token read with PPM's own headers came back `eligible: false, ineligible_reason: "surface"`
 * with no grant listed, and with these it listed every grant claude.ai shows (measured
 * 2026-11-13). Going out as the CLI was the user's call, made knowing it is not PPM's usual
 * rule (the chat subprocess keeps `CLAUDE_CODE_ENTRYPOINT=ppm`). Keep it to these calls.
 *
 * The version is the Claude Code the bundled Agent SDK ships (`claudeCodeVersion` in its
 * package.json); `claude-limit-reset-service.test.ts` fails when an SDK bump leaves it behind.
 */
export const CLAUDE_CLI_VERSION = "2.1.322";

export function claudeCliHeaders(): Record<string, string> {
  return {
    "User-Agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
    "x-app": "cli",
  };
}
