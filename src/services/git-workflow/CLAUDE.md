# `src/services/git-workflow/`

## Gotchas

- **`git pull` refuses a diverged branch on git ≥ 2.33 unless the repository says how to reconcile**: it fails with "Need to specify how to reconcile divergent branches", so a Pull or Sync button works every time until the first time it is needed. `git-workflow.service.ts` adds `--no-rebase` (a merge, as GitHub Desktop does) only when none of `pull.rebase`, `pull.ff` and `branch.<name>.rebase` is set — passed unconditionally it would override `pull.ff = only` and merge anyway.
- **`git stash pop`/`apply` without `--index` puts staged changes back unstaged, silently**; with it, git refuses outright when the staged part no longer applies, and touches nothing. So `git-workflow.service.ts` tries `--index` first, falls back to a plain apply, and the UI says the changes "came back unstaged". It also checks the hash of `stash@{n}` before acting, because the list renumbers whenever anything else pushes or drops a stash.
