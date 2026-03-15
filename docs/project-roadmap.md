# PPM Project Roadmap & Status

**Last Updated:** March 15, 2026

## Current Version: v2.0 (In Progress)

### Overall Progress: 85%

Multi-project, project-scoped API refactor with improved UX.

---

## Phase Breakdown

### Phase 1: Project Skeleton ✅ Complete
- Bun runtime setup, TypeScript configuration
- CLI with Commander.js
- Hono server basic structure
- React frontend with Vite

**Status:** Done (v1 foundation)

---

### Phase 2: Backend Core ✅ Complete
- Services: ProjectService, ConfigService, FileService, GitService
- YAML-based project registry
- Path traversal protection
- Auth middleware (token-based)

**Status:** Done, enhanced in v2

**Latest Work (260315):**
- Project-scoped API refactor: `/api/project/:name/*` routes
- ProviderRegistry singleton pattern

---

### Phase 3: Frontend Shell ✅ Complete
- React layout (Sidebar, TabBar, MainArea)
- Zustand stores (project, tab, file, settings)
- Theme switcher (dark/light/system)
- Mobile responsive navigation

**Status:** Done, improved in v2

**Latest Work (260315):**
- Mobile nav refactor, tab bar auto-scroll
- URL sync for project/tab/file state
- Tab metadata persistence in localStorage

---

### Phase 4: File Explorer & Editor ✅ Complete
- FileTree component with directory expansion
- CodeMirror 6 integration with syntax highlighting
- File read/write operations
- Diff viewer (Diff2HTML)

**Status:** Done

**Latest Work (260315):**
- Chat file attachments (drag-drop, paste)
- File viewer for images/PDFs/markdown
- Better error messages

---

### Phase 5: Web Terminal ✅ Complete
- xterm.js integration
- Bun native PTY (Bun.spawn with shell)
- Terminal I/O via WebSocket
- Resize handling (SIGWINCH)

**Status:** Done

**Latest Work:**
- Multiple terminal sessions per project
- Terminal session persistence in tabs

---

### Phase 6: Git Integration ✅ Complete
- GitService with simple-git
- Status view (staged, unstaged, untracked)
- Diff viewer (file-level and project-level)
- Commit graph (Mermaid-based visualization)

**Status:** Done

**Latest Work (260315):**
- Git staging UI improvements
- Commit graph performance optimization
- Branch list, PR URL detection

---

### Phase 7: AI Chat ✅ Complete
- Claude Agent SDK integration
- Message streaming (async generators)
- Tool use (file_read, file_write, git commands)
- Tool approval flow

**Status:** Done

**Latest Work (260315):**
- File attachments in chat
- Slash command detection (/help, /git, /file)
- Usage badge (token tracking)
- Session management (save/load)

---

### Phase 8: CLI Commands ✅ Complete
- `ppm start` — Start server (foreground/daemon)
- `ppm stop` — Graceful shutdown
- `ppm open` — Launch browser
- `ppm init` — Initialize config
- `ppm projects {add,remove,list}` — Project management
- `ppm config {get,set}` — Configuration
- `ppm git {status,commit,branch}` — Git operations
- `ppm chat {send,sessions,delete}` — Chat CLI

**Status:** Done

---

### Phase 9: PWA & Build ✅ Complete
- Vite build configuration
- Service worker (vite-plugin-pwa)
- Offline support (cached assets)
- Manifest.json (installable)
- Binary compilation (`bun build --compile`)

**Status:** Done

---

### Phase 10: Testing ✅ In Progress (60%)

#### Unit Tests (40% complete)
- [x] Mock provider tests
- [x] ChatService tests
- [ ] FileService tests
- [ ] GitService tests
- [x] Zustand store tests

#### Integration Tests (30% complete)
- [x] Claude Agent SDK integration
- [x] Chat WebSocket flow
- [ ] Terminal WebSocket flow
- [ ] Git operations
- [ ] File operations

#### E2E Tests (0% — Planned for v3)

**Status:** Partial, needs completion

---

## Known Issues & Gaps (v2)

### Critical (Blocking)
1. **Terminal on Windows** — Node-pty complexity; Bun PTY may not work
   - Mitigation: Document Linux/macOS support, add Windows detection
   - Fix: Evaluate node-pty or WSL fallback

2. **Chat streaming cancellation** — Cancel button partially working
   - Issue: Async generator hard to interrupt mid-stream
   - Fix: Implement CancellationToken pattern

### High Priority (Should Fix)
3. **File path encoding** — Unicode filenames may break
   - Fix: Validate UTF-8, handle encoding edge cases

4. **Large file handling** — No streaming for large files (>10MB)
   - Fix: Chunk file reads, show progress bar

5. **Git performance** — `git log --graph` slow on large repos
   - Fix: Limit graph depth, add pagination

### Medium Priority (Nice to Have)
6. **Dark mode OLED** — No true black background
   - Fix: Add separate OLED mode in settings

7. **Keyboard shortcuts** — Limited shortcuts defined
   - Fix: Add Cmd+K, Cmd+P (file search), Cmd+/ (comment)

8. **Session persistence** — Chat history lost on server restart
   - Fix: Persist sessions to filesystem or localStorage with IndexedDB

9. **Collaborative editing** — No multi-user support
   - Status: Planned for v3

10. **Mobile terminal** — Terminal hard to use on small screens
    - Fix: Optimize touch input, add virtual keyboard

---

## v2.0 Checklist

- [x] Project-scoped API refactor
- [x] Per-project chat sessions
- [x] Per-project git operations
- [x] Multi-tab UI with state persistence
- [x] File attachments in chat
- [x] Mobile responsive improvements
- [x] URL sync for bookmarking/sharing
- [ ] Complete test coverage (60% complete)
- [ ] Documentation (in progress)
- [ ] Security audit (planned)

**Target Release:** March 31, 2026

---

## Upcoming Features (v3.0)

### Collaborative Editing (High Priority)
- Real-time multi-user file editing
- Cursor synchronization via WebSocket
- Conflict resolution (OT or CRDT)
- User presence indicators

**Estimated Effort:** 3 weeks
**Dependencies:** CRDT library (yjs or automerge)

---

### Custom Tool Registry
- Allow users to define custom AI tools (shell scripts, HTTP endpoints)
- Tool UI generator based on JSON schema
- Rate limiting and sandboxing

**Estimated Effort:** 2 weeks
**Dependencies:** JSON Schema library

---

### Plugin Architecture
- Load custom providers from npm or local plugins
- Provider discovery and versioning
- Hot-reload support

**Estimated Effort:** 2 weeks
**Dependencies:** Plugin loader (Rollup, Module Federation)

---

### Performance Profiling UI
- Flamegraph viewer for CPU profiling
- Memory allocation tracking
- Network waterfall visualization

**Estimated Effort:** 1 week
**Dependencies:** Profiling library (speedscope, Clinic.js)

---

### Advanced Git Features
- Interactive rebase UI
- Cherry-pick/squash support
- Stash management
- Rebase conflict resolution
- Submodule support

**Estimated Effort:** 2 weeks
**Dependencies:** Existing simple-git wrapper

---

### Cross-Platform Distribution (Planned)
- Compile platform-specific binaries via `bun build --compile` (macOS, Linux, Windows)
- Publish npm package with wrapper script that auto-detects platform and downloads correct binary
- Enables `npx ppm init` without requiring Bun on the target machine
- CI/CD pipeline for automated multi-platform builds on release

**Estimated Effort:** 1 week
**Dependencies:** CI/CD (GitHub Actions), npm publish pipeline

---

### Cloud Sync (Future)
- Optional cloud backup of chat sessions
- Cross-device session sync
- Settings synchronization

**Estimated Effort:** 3 weeks
**Dependencies:** Cloud storage API (AWS S3, Dropbox)
**Note:** Single-machine only in v2; this would be v4+

---

## Technical Debt

| Item | Priority | Effort | Notes |
|------|----------|--------|-------|
| Simplify ChatService streaming | Medium | 1d | Reduce async generator complexity |
| Extract WebSocket common logic | Low | 1d | DRY principle for chat/terminal WS |
| Improve error messages | Medium | 2d | More actionable error text |
| Add request logging | Low | 0.5d | Debugging aid |
| Refactor FileService validation | Low | 1d | Centralize path checks |
| Remove unused provider fallbacks | Low | 0.5d | Clean up mock/claude-cli code |

---

## Testing Coverage Targets

| Area | Current | Target v2 | Target v3 |
|------|---------|-----------|-----------|
| **Services** | 60% | 90% | 95% |
| **Routes** | 40% | 80% | 95% |
| **Hooks** | 30% | 70% | 90% |
| **Components** | 10% | 50% | 80% |
| **Overall** | 35% | 75% | 90% |

---

## Community & Contribution Roadmap

### v2 (Current)
- [ ] GitHub issue templates
- [ ] Contribution guidelines (CONTRIBUTING.md)
- [ ] Developer setup guide
- [ ] Automated CI/CD (GitHub Actions)

### v3
- [ ] Plugin development guide
- [ ] API documentation (OpenAPI/Swagger)
- [ ] Example plugins repository
- [ ] Community provider registry

---

## Release Schedule (Target Dates)

| Version | Status | Features | Target Date |
|---------|--------|----------|-------------|
| **v1.0** | Released | Single project, basic chat, terminal | Feb 28, 2025 |
| **v2.0** | In Progress | Multi-project, project-scoped API, improved UX | Mar 31, 2026 |
| **v2.1** | Planned | Bug fixes, performance improvements | Apr 15, 2026 |
| **v3.0** | Planned | Collaborative editing, custom tools, plugins | Jun 30, 2026 |
| **v4.0** | Planned | Cloud sync, advanced git, profiling UI | Sep 30, 2026 |

---

## Success Metrics

### Adoption (By v2 Release)
- 10+ active users (internal + early adopters)
- 100+ GitHub stars
- 50+ questions/issues on GitHub

### Performance
- Server startup: <500ms
- API response: <200ms (50th percentile)
- WebSocket latency: <50ms
- Frontend bundle: <800KB gzipped

### Quality
- Test coverage: >75%
- Security vulnerabilities: 0
- Critical bugs in v2: <3

### Developer Experience
- Time to first commit: <30 minutes
- Documentation completeness: 90%
- Contribution acceptance rate: >80%

---

## Dependencies to Monitor

| Dependency | Version | Risk | Monitoring |
|-----------|---------|------|-----------|
| Bun | 1.3.6+ | Medium | Check security advisories weekly |
| Claude Agent SDK | 0.2.76 | Low | Follow Anthropic releases |
| React | 19.2.4 | Low | Monitor for breaking changes |
| TypeScript | 5.9.3 | Low | Plan upgrades quarterly |
| xterm.js | 6.0 | Low | Check for terminal rendering bugs |

---

## Q&A

**Q: Why no cloud sync in v2?**
A: Complexity & scope. Single-machine focus allows faster iteration. Cloud features are v4+ when user base justifies.

**Q: When will Windows be fully supported?**
A: Investigating Bun PTY behavior. Windows support likely in v3 pending testing.

**Q: Can I self-host on a server?**
A: Yes, but no user isolation. Each user would need their own instance. Multi-user hosting planned for v4.

**Q: Will there be mobile apps (iOS/Android)?**
A: Web PWA first (installed on home screen). Native apps only if there's strong demand.

**Q: How do I contribute?**
A: v2 first focuses on internal stability. Contribution guidelines coming in v2.1. For now, open issues for bugs/features.

