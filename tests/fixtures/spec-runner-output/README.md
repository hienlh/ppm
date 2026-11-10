Real output of each test runner, used by `tests/unit/specs/test-judge.test.ts`. The last line
`exit=N` is the exit code the run ended with.

- `bun-*`, `go-*`, `cargo-*` were captured from bun 1.3.11, go and cargo on 2026-11-10 (paths
  under the scratch folder rewritten to `/work/`).
- `pytest-*`, `vitest-*` and `jest-*` are written from each runner's documented default
  reporter, because none of them was installed where these were made. Replace them with
  captured output when one is at hand.
