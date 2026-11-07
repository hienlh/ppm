---
trigger: always_on
---

# Building PPM

Build with `bun run build`, unchanged. Do not write your own `bun build … --compile` command, do not drop steps or add flags, and do not use `scripts/build.ts` (stale, same flaw). If the binary has to go somewhere else, copy the `build` script from `package.json` as it is and change only `--outfile`.

Leaving a step out still builds without any error, and ships a broken PPM:

- `bun build` takes three entry points: `src/index.ts`, `src/services/extension-host-worker.ts`, `src/services/file-index/file-index-worker.ts`. A worker that is not an entry point is not in the binary.
  - Without the extension host worker, every extension fails with `RPC timeout: ext:activate (10000ms)`: no Git Graph.
  - Without the file-index worker, every file-index walk runs on the server's main thread.
- `build:web` empties `dist/web`, so `scripts/copy-monaco.ts` and `scripts/precompress-web.ts` must run after it. Without them the code editor never loads (no Monaco) and no `.br`/`.gz` files are served.

A new `Worker` must be added to the `build` script's entry list; `tests/unit/scripts/release-compile-entries.test.ts` then requires `scripts/release.sh` and `.github/workflows/release.yml` to match.

Why: on 2026-11-06 a one-entry build (`bun build --compile --minify src/index.ts --outfile dist/ppm.new`) went live at 23:18 and again at 00:30 (+07), and Git Graph failed with that RPC timeout.

## Check before restarting

On the binary you are about to put live (`dist/ppm`, or your `--outfile`), both must print 1 or more:

    grep -ac 'bunfs/root/services/extension-host-worker' dist/ppm
    grep -ac 'bunfs/root/services/file-index/file-index-worker' dist/ppm

`dist/web/assets/monaco` must exist. After the restart, `ppm logs --tail 200` must show `activated @ppm/ext-git-graph successfully` and no `ModuleNotFound`.
