# Add Claude Fable 5 model + sort model list by power

**Date:** 2026-06-11
**Commit:** `a44a77c` (branch `integrate-0.13.96`)
**Plan:** `plans/260611-1010-add-claude-fable-5-model/`

## What

Added `claude-fable-5` (Anthropic's new public flagship, released 2026-06-09) to PPM's model registry. Default model changed `claude-sonnet-4-6` → `claude-opus-4-8`. All model lists sorted by power, strongest first: Fable 5 → Opus 4.8 → 4.7 → 4.6 → Sonnet 4.6 → Haiku 4.5.

## Why those decisions

- Triggered by a screenshot of Anthropic's model picker ("Fable 5 — Included until June 22"). Researched: it's `claude-fable-5`, 1M ctx, 128k out, $10/$50 per MTok.
- Default set to Opus 4.8 (not Fable) — user chose cost-conscious default; Fable is pricey and opt-in per session.
- "Included until June 22" is an app access-window, not an API deadline → no auto-hide/expiry mechanism (YAGNI).

## Touchpoints

Registry is 3 hardcoded spots: `claude-agent-sdk.ts` `listModels()`, `config.ts` (`VALID_MODELS` + default), `init.ts` (choices + default). Frontend picker is data-driven (no change). Proxy tester (`proxy-test-section.tsx`) keeps its own hardcoded list — updated for parity.

## Notable

- Tester subagent caught a second model-list assertion (project-scoped endpoint) I'd missed in the same test file.
- Code-reviewer caught a factual regression: README `-y` default still said sonnet.
- **Proxy bridge gap (deferred):** `proxy-sdk-bridge.ts` `mapModelToSdkModel()` routes by substring (opus/haiku/else→sonnet) — `claude-fable-5` matches neither, so it silently routes to Sonnet through the proxy. Out of scope this round; flag for follow-up if proxy must honor Fable.
- Tests must run via Docker (`oven/bun`) — host Bun segfaults. 46/46 model-related tests green; the 80 full-suite failures are pre-existing env-dependent suites (live SDK, git-graph, binary-spawn).
- Branch had in-flight edit-message/session-branch WIP; used split-staging (`git add -p` + `git apply --cached`) to keep the model commit clean.

## Not done

- `package.json` version bump (separate release step — user decides patch/minor).
- Proxy SDK bridge fable routing (see gap above).
