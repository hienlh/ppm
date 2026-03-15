# Code Review: AI Provider Settings

## Scope
- **Files**: 11 changed/created, 3 deleted
- **LOC**: ~350 new/modified
- **Focus**: Security (API validation), correctness (config merging), edge cases, code quality

## Overall Assessment

Solid implementation. Clean separation of concerns: types + validation in `config.ts`, REST in `settings.ts`, SDK integration in `claude-agent-sdk.ts`, frontend form in `ai-settings-section.tsx`. Tests cover validation boundaries and route behavior well (18/18 passing). TypeScript compiles clean.

---

## Critical Issues

**None found.**

---

## High Priority

### H1. `model` field is not validated server-side
`validateAIProviderConfig()` validates effort, max_turns, budget, and thinking tokens but **not** model. A client can PUT `{ model: "" }` or `{ model: "../../etc/passwd" }` and it gets written to yaml and passed to the SDK `query()` call.

**Impact**: Could cause SDK errors or unexpected behavior. Not a direct security vuln since the SDK validates its own inputs, but defense-in-depth is warranted.

**Fix**: Add model validation (allowlist or format check):
```ts
const VALID_MODELS = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"];
if (config.model && !VALID_MODELS.includes(config.model)) {
  errors.push(`model must be one of: ${VALID_MODELS.join(", ")}`);
}
```

### H2. `type` field is not validated on PUT
A client can change `type` to any string via the API (e.g., `{ type: "evil" }`). The shallow merge in `settings.ts` line 42-43 will write it to disk. Provider registry only supports `"agent-sdk"` and `"mock"`.

**Fix**: Validate `type` in `validateAIProviderConfig`:
```ts
const validTypes = ["agent-sdk", "mock"];
if (config.type && !validTypes.includes(config.type)) {
  errors.push(`type must be one of: ${validTypes.join(", ")}`);
}
```

### H3. `default_provider` can be set to nonexistent provider
PUT `{ default_provider: "nonexistent" }` succeeds. When `getProviderConfig()` runs, `ai.providers[providerId]` returns `undefined`, falling back to `{}`. All config-driven options become undefined -- no model, no effort, no maxTurns default.

**Impact**: `maxTurns` falls back to `undefined` (line 258: `providerConfig.max_turns ?? 100` would be `100` -- OK). But `model` and `effort` would be `undefined`, sent to SDK as missing. Behavior depends on SDK defaults. Could silently degrade.

**Fix**: Validate `default_provider` exists in providers:
```ts
if (body.default_provider && !updated.providers[body.default_provider]) {
  return c.json(err(`Provider "${body.default_provider}" not found`), 400);
}
```

---

## Medium Priority

### M1. Shallow merge can't clear optional fields
Once `max_budget_usd` is set, there's no way to clear it via the API. The frontend sends `undefined` for empty fields (line 135: `isNaN(val) ? undefined : val`), but `undefined` values don't overwrite existing keys in spread: `{ ...existing, max_budget_usd: undefined }` keeps the old value.

**Fix**: Support explicit `null` to delete fields:
```ts
// In settings.ts merge logic
for (const [key, val] of Object.entries(config)) {
  if (val === null) delete merged[key];
  else merged[key] = val;
}
```

### M2. No integer validation for `thinking_budget_tokens` and `max_turns`
`validateAIProviderConfig` checks ranges but not that values are integers. `{ max_turns: 1.5 }` passes validation. The SDK may truncate or reject non-integer turns.

**Fix**: Add integer check:
```ts
if (config.max_turns != null && !Number.isInteger(config.max_turns)) {
  errors.push("max_turns must be an integer");
}
```

### M3. Frontend uses `defaultValue` instead of controlled `value` for number inputs
`ai-settings-section.tsx` lines 115, 131, 146 use `defaultValue`. If settings are saved and the response changes the value (e.g., server clamps it), the input won't update to reflect the new value. The form shows stale data until remount.

**Fix**: Switch to controlled inputs with `value` and `onChange`, or re-key the component on settings change.

### M4. No debounce on blur-to-save
Each field blur triggers an API call immediately. Rapid tab-through could fire multiple concurrent PUT requests. Since `configService.save()` does synchronous `writeFileSync`, no data corruption, but unnecessary network + disk IO.

**Fix**: Add debounce or a single "Save" button.

### M5. GET `/settings/ai` returns `api_key_env` value
The GET response includes `api_key_env: "ANTHROPIC_API_KEY"` (the env var name). This is not the actual key, so it's not a direct leak, but it reveals which env var holds the API key -- information disclosure.

**Fix**: Strip `api_key_env` from GET response or replace with `"***"`.

---

## Low Priority

### L1. `as any` on query options (line 265)
The SDK options object is cast to `any` to bypass type checking. If the SDK changes its API, TypeScript won't catch mismatched option names.

### L2. Frontend `AIProviderSettings.effort` is typed as `string`
Should be `"low" | "medium" | "high" | "max"` to match backend type.

### L3. JSON schema `thinking_budget_tokens` says "0 = disabled"
But `validateAIProviderConfig` only checks `>= 0`. If SDK interprets 0 as "no thinking" vs "unlimited", document this explicitly.

### L4. Duplicate `configService.set` + `configService.save` pattern
Consider a `configService.update(key, value)` method that sets + saves atomically.

---

## Edge Cases Found

1. **Concurrent PUT requests**: Two simultaneous PUTs could interleave reads. Both read the same `currentAi`, both merge, last writer wins. Not critical (single-user app) but worth noting.
2. **Empty providers object in PUT**: `{ providers: {} }` passes validation, does nothing harmful -- OK.
3. **Very large `thinking_budget_tokens`**: No upper bound. `{ thinking_budget_tokens: 999999999 }` is accepted. SDK may reject or burn through budget. Consider an upper bound.
4. **`max_budget_usd` at exactly 0.01**: Boundary accepted correctly per tests.
5. **Non-numeric string in number input**: Frontend `parseInt`/`parseFloat` returns `NaN`, handled correctly (sends `undefined`). But see M1 re: inability to clear.

---

## Positive Observations

- Validation function is pure and well-tested (13 test cases covering boundaries)
- Route tests properly isolate state with `resetConfig()` using `structuredClone`
- Config-driven SDK options use conditional spread `...(field && { key: field })` -- clean pattern
- `getProviderConfig()` reads fresh config each call -- settings take effect without restart
- API follows existing envelope convention (`ok`/`err` helpers)
- JSON schema for yaml autocomplete is a nice DX touch
- Clean deletion of unused CLI provider files

---

## Recommended Actions (Priority Order)

1. **[H1]** Add model validation (allowlist)
2. **[H2]** Add type validation
3. **[H3]** Validate default_provider references an existing provider
4. **[M1]** Support `null` to clear optional fields
5. **[M2]** Add integer checks for max_turns and thinking_budget_tokens
6. **[M3]** Fix stale defaultValue in number inputs

---

## Metrics

- Type Coverage: Good (one `as any` in SDK options)
- Test Coverage: 18 tests covering validation + routes; no frontend component tests
- Linting Issues: 0
- Build: Clean
