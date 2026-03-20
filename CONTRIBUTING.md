# Contributing to PPM

Thanks for your interest in contributing!

## Getting Started

```bash
git clone https://github.com/hienlh/ppm.git
cd ppm && bun install

bun dev:server    # Backend on port 8081
bun dev:web       # Frontend on port 5173
```

Requires: **Bun v1.3.6+**, **Git v2.0+**, **Claude Code** authenticated.

## How to Contribute

1. **Fork** the repo and create a branch from `main`
2. **Make changes** — keep PRs focused and small
3. **Test** — run `bun test` and make sure all tests pass
4. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` new feature
   - `fix:` bug fix
   - `docs:` documentation only
   - `refactor:` code change without new feature or bug fix
   - `test:` adding or updating tests
   - `chore:` tooling, deps, config
5. **Open a PR** against `main`

## Guidelines

- Keep files under 200 lines — split into focused modules if needed
- Follow YAGNI / KISS / DRY principles
- No secrets or `.env` files in commits
- Run `bun run typecheck` before submitting

## Reporting Bugs

Use `ppm report` to file a bug — it pre-fills environment info and logs automatically.

Or open an issue on [GitHub](https://github.com/hienlh/ppm/issues).

## License

By contributing, you agree your contributions will be licensed under the [MIT License](LICENSE).
