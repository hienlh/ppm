# Phase 1: Project Skeleton + Shared Types

**Owner:** Lead
**Priority:** Critical
**Depends on:** None
**Effort:** Small

## Overview

Initialize monorepo, install dependencies, create shared types, config files. This unblocks all other phases.

## Steps

1. **Init Bun project**
   ```bash
   bun init
   ```

2. **Install backend dependencies**
   ```bash
   bun add hono commander js-yaml simple-git node-pty @anthropic-ai/claude-agent-sdk
   bun add -d @types/node typescript
   ```

3. **Install frontend dependencies**
   ```bash
   bun add react react-dom zustand @tanstack/react-query
   bun add -d vite @vitejs/plugin-react tailwindcss @tailwindcss/vite vite-plugin-pwa
   bun add codemirror @codemirror/lang-javascript @codemirror/lang-typescript @codemirror/lang-python @codemirror/lang-html @codemirror/lang-css @codemirror/lang-json @codemirror/lang-markdown @codemirror/autocomplete @codemirror/merge @codemirror/theme-one-dark @uiw/react-codemirror
   bun add @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
   bun add diff2html react-resizable-panels
   ```

4. **Init shadcn/ui**
   ```bash
   bunx --bun shadcn@latest init
   bunx --bun shadcn@latest add button dialog dropdown-menu context-menu input tabs scroll-area tooltip separator
   ```

5. **Create config files**
   - `tsconfig.json` — strict, paths alias `@/` → `src/web/`
   - `vite.config.ts` — React plugin, Tailwind, PWA plugin, build output to `dist/web`
   - `tailwind.config.ts` — shadcn/ui preset, mobile-first
   - `bunfig.toml` — Bun config
   - `ppm.example.yaml` — example config
   - `.env.example` — `ANTHROPIC_API_KEY=`
   - `.gitignore`

6. **Create shared types** (`src/types/`)
   - `config.ts` — PpmConfig, AuthConfig, ProjectConfig, AIProviderConfig
   - `project.ts` — Project, ProjectInfo
   - `git.ts` — GitCommit, GitBranch, GitStatus, GitGraphData, GitDiffResult, GitFileChange
   - `chat.ts` — AIProvider interface, ChatEvent, SessionConfig, SessionInfo, ToolApprovalRequest
   - `terminal.ts` — TerminalSession, TerminalResize
   - `api.ts` — API request/response wrappers

7. **Create entry point** `src/index.ts` — minimal Commander.js setup with `start` command placeholder

8. **Create README.md** with project description, setup instructions

9. **Create CLAUDE.md** with project conventions

10. **Verify build**
    ```bash
    bun run src/index.ts --help
    ```

## Files to Create

- `package.json`, `tsconfig.json`, `vite.config.ts`, `tailwind.config.ts`, `bunfig.toml`
- `ppm.example.yaml`, `.env.example`, `.gitignore`
- `src/index.ts`
- `src/types/*.ts` (6 files)
- `README.md`, `CLAUDE.md`, `LICENSE`

## Success Criteria

- [x] `bun run src/index.ts --help` shows CLI help
- [x] `bun run --hot src/web/main.tsx` (via vite) starts dev server
- [x] All shared types compile without errors
- [x] shadcn/ui components installed and importable
