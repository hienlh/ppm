# Phase 2: Backend Core (Server + CLI + Config)

**Owner:** backend-dev
**Priority:** Critical
**Depends on:** Phase 1
**Effort:** Medium

## Overview

Hono HTTP server, WebSocket upgrade, config loading, auth middleware, static file serving. CLI `init`, `start`, `stop`, `open` commands.

## Key Insights

- Hono on Bun has built-in WebSocket support via `Bun.serve`
- Config loaded from `ppm.yaml` via js-yaml, validated at startup
- Auth = simple Bearer token header check
- Static files = serve Vite build output from `dist/web/`

## Files to Create/Modify

```
src/
├── server/
│   ├── index.ts              # Hono app, mount routes, WS upgrade
│   ├── middleware/auth.ts     # Token auth
│   ├── routes/static.ts       # Serve SPA with fallback to index.html
│   └── routes/projects.ts     # GET /api/projects, POST /api/projects
├── services/
│   ├── config.service.ts      # Load/save ppm.yaml
│   └── project.service.ts     # Project CRUD (add/remove/list)
├── cli/
│   ├── index.ts               # Commander.js program setup
│   ├── commands/init.ts       # Scan .git folders, interactive setup
│   ├── commands/start.ts      # Start Hono server (+ daemon mode)
│   ├── commands/stop.ts       # Kill daemon by PID file
│   ├── commands/open.ts       # Open browser to http://localhost:PORT
│   └── utils/project-resolver.ts  # CWD detect + -p flag
└── index.ts                   # Wire CLI → commands
```

## Implementation Steps

### 1. Config Service
```typescript
// config.service.ts
class ConfigService {
  private config: PpmConfig;
  load(path?: string): PpmConfig    // Default: ~/.ppm/config.yaml or ./ppm.yaml
  save(): void
  get<K extends keyof PpmConfig>(key: K): PpmConfig[K]
  set<K extends keyof PpmConfig>(key: K, value: PpmConfig[K]): void
}
```
- Search order: `--config` flag → `./ppm.yaml` → `~/.ppm/config.yaml`
- Create default config on first run

### 2. Project Service
```typescript
class ProjectService {
  constructor(private config: ConfigService)
  list(): ProjectInfo[]
  add(path: string, name?: string): void
  remove(nameOrPath: string): void
  resolve(nameOrPath?: string): Project  // CWD or -p flag
  scanForGitRepos(dir: string): string[] // Find .git folders recursively
}
```

### 3. Hono Server
```typescript
// server/index.ts
const app = new Hono()
app.use('/api/*', authMiddleware)
app.route('/api/projects', projectRoutes)
// WS upgrade handled at Bun.serve level
// Static files: serve dist/web/ with SPA fallback
```

### 4. Auth Middleware
- Check `Authorization: Bearer <token>` header
- Skip auth if `config.auth.enabled === false`
- Return 401 on failure

### 5. CLI Commands
- `ppm init` — interactive: scan parent dir for .git, prompt to add, create config
- `ppm start` — start Hono server, optionally daemonize (`-d` flag → detach process, write PID to `~/.ppm/ppm.pid`)
- `ppm stop` — read PID file, kill process
- `ppm open` — `open http://localhost:${port}` (macOS) / `xdg-open` (Linux)

### 6. Project Resolver
```typescript
function resolveProject(options: { project?: string }): Project {
  if (options.project) return projectService.resolve(options.project);
  const cwd = process.cwd();
  const match = projectService.list().find(p => cwd.startsWith(p.path));
  if (match) return match;
  throw new Error('Not in a registered project. Use -p <name>');
}
```

## Success Criteria

- [ ] `ppm init` scans current dir, creates config file
- [ ] `ppm start` starts HTTP server, serves placeholder page
- [ ] `ppm start -d` runs as daemon, `ppm stop` kills it
- [ ] `GET /api/projects` returns project list (with auth token)
- [ ] 401 returned without valid token
- [ ] `ppm open` opens browser
