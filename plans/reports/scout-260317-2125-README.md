# Scout Report: Cloud-CLI vs PPM Claude Integration Comparison

**Completed**: 2026-03-17 | **Scout**: Codebase Scout | **Task ID**: scout-260317-2125

---

## Report Overview

This is a comprehensive analysis comparing how Cloud-CLI (cloud-code-ui) and PPM (Project & Process Manager) integrate with Claude Code and the @anthropic-ai/claude-agent-sdk.

**Total Files Generated**: 3 detailed reports + this index

---

## Generated Reports

### 1. **Key Findings** (Start Here)
📄 `scout-260317-2125-key-findings.md` — **RECOMMENDED FIRST READ**

Quick reference with:
- TLDR comparison table
- 3 critical gaps identified
- Priority implementation roadmap
- Code location references
- 30-minute takeaway summary

**Read time**: 10 minutes | **Best for**: Quick overview, decision-making

---

### 2. **Comprehensive Comparison**
📄 `scout-260317-2125-cloud-cli-claude-integration-comparison.md`

Full technical analysis covering:
- Architecture overview (both projects)
- 9 key differences detailed
- CLAUDE.md handling comparison
- Permission & tool management
- Session management patterns
- MCP server management
- Custom commands system
- Configuration & settings
- Multi-provider support
- Error handling & notifications
- Feature matrix for PPM roadmap
- Code quality analysis
- Unresolved questions

**Read time**: 30 minutes | **Best for**: Deep understanding, architecture decisions

---

### 3. **File & Component Map**
📄 `scout-260317-2125-cloud-cli-ppm-file-map.md`

Visual structure guide with:
- Directory trees for both projects
- Core files highlighted
- Feature-by-feature code comparison
- WebSocket message types
- SDK configuration options
- Multi-provider architecture
- Configuration sources
- Line-by-line implementation details

**Read time**: 20 minutes | **Best for**: Finding specific code, understanding patterns

---

## Quick Reference Tables

### Most Critical Differences

| Feature | Cloud-CLI | PPM | Priority |
|---------|-----------|-----|----------|
| CLAUDE.md support | ✅ Full | ❌ Missing | **HIGH** |
| Permission modes | 6+ modes | 1 mode | **MEDIUM** |
| Session persistence | In-memory | File-based ✅ | PPM advantage |
| Custom commands | 8 built-in | None | **LOW** |

### Feature Adoption Priorities for PPM

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| **HIGH** | CLAUDE.md preset loading | 30 mins | Enables project instructions |
| **HIGH** | settingSources configuration | 15 mins | Required for CLAUDE.md |
| **MEDIUM** | Plan permission mode | 2-3 hrs | Planning workflows |
| **MEDIUM** | Session reconnection | 2-3 hrs | UX improvement |
| **MEDIUM** | Image upload support | 2-3 hrs | UX enhancement |
| **LOW** | Custom command system | 8-10 hrs | Power user feature |
| **LOW** | Permission pattern matching | 3-4 hrs | Advanced rules |
| **LOW** | MCP server UI | 5-6 hrs | Discovery/add/remove |

---

## Key Findings Summary

### What Cloud-CLI Does Better
- Full CLAUDE.md preset support (project instructions)
- Multiple permission modes (plan, yolo, bypassPermissions, etc)
- Custom command system with dynamic discovery
- MCP server UI management
- Multi-provider integration (Claude, Cursor, Gemini, Codex)
- Image upload handling
- Notification system with web-push

### What PPM Does Better
- File-based session persistence (survives restarts)
- Cleaner TypeScript architecture
- Focused scope (Claude-only)
- Provider interface for extensibility

### Critical Gaps in PPM
1. **CLAUDE.md not loaded** — Project instructions not passed to Claude
2. **Simple permission model** — No plan mode or pattern matching
3. **No custom commands** — Extensibility limited

### Recommended Immediate Action
**Add CLAUDE.md support to PPM** (3 lines of code):
```typescript
systemPrompt: { type: 'preset', preset: 'claude_code' },
settingSources: ['project', 'user', 'local'],
```
Location: `src/providers/claude-agent-sdk.ts`

---

## Architecture at a Glance

### Cloud-CLI
```
Browser UI → Express Server → SDK query() → ~/.claude/ files
            ↓ (claude-sdk.js 844 lines)
            ├─ Permission mapping
            ├─ Tool approval workflow
            ├─ Session tracking
            ├─ Image handling
            └─ Token budget
```

### PPM
```
Browser UI → Hono/Bun → SDK query() → ~/.claude/ files
            ↓ (claude-agent-sdk.ts ~500 lines)
            ├─ Simple approval
            ├─ Config service
            └─ Session mapping (persistent)
```

---

## Code Locations

### Cloud-CLI Core Files
- **SDK wrapper**: `server/claude-sdk.js` (844 lines)
- **CLAUDE.md loading**: Lines 199-206
- **Permission modes**: Lines 144-214
- **Tool approval**: Lines 520-601
- **Session management**: Lines 223-257
- **Custom commands**: `server/routes/commands.js` (Lines 21-130)
- **MCP management**: `server/routes/mcp.js`
- **Multi-provider**: `server/{claude,cursor,gemini,codex}.js`

### PPM Core Files
- **SDK provider**: `src/providers/claude-agent-sdk.ts`
- **WebSocket handler**: `src/server/ws/chat.ts`
- **Config service**: `src/services/config.service.ts`
- **Chat hook**: `src/web/hooks/use-chat.ts`
- **Project instructions**: `./CLAUDE.md` (exists but unused)

---

## How These Reports Were Generated

1. **Scanned Cloud-CLI**: `package.json`, `server/claude-sdk.js`, `server/routes/`, project structure
2. **Scanned PPM**: `CLAUDE.md`, `src/providers/`, `src/server/`, config files
3. **Analyzed SDK usage**: Both projects' SDK option mapping and configuration
4. **Identified patterns**: Permission handling, session management, feature coverage
5. **Created comparison matrix**: Features, file locations, recommendations

---

## Next Steps

### For PPM Team
1. Review `scout-260317-2125-key-findings.md` (10 mins)
2. Assess CLAUDE.md implementation impact (determine if valuable)
3. If yes: Implement HIGH priority features (1-2 hours)
4. Consider MEDIUM priority features for future sprints
5. Reference `scout-260317-2125-cloud-cli-ppm-file-map.md` during implementation

### For Cloud-CLI Learning
- These reports show how Cloud-CLI implements advanced features
- Useful reference for improving PPM's feature set
- Permission mode implementation particularly valuable

---

## Report Metadata

| Aspect | Details |
|--------|---------|
| Generated | 2026-03-17 |
| Scout | Codebase Scout Agent |
| Work Context | /Users/hienlh/Projects/cloud-cli |
| Report Path | /Users/hienlh/Projects/ppm/plans/reports/ |
| Total Tokens | ~15,000 (comprehensive analysis) |
| Files Analyzed | 20+ (cloud-cli + ppm) |
| Code Locations | 50+ specific references |

---

## Unresolved Questions

1. Does Cloud-CLI's plan mode have documented format for permission rules?
2. How does Cloud-CLI handle project switching between ~/.claude projects?
3. Does PPM plan to implement CLAUDE.md preset loading?
4. What's the migration path if PPM wants MCP management UI?
5. How do permission timeouts interact with long-running tool executions?

---

## Document Index

```
plans/reports/
├── scout-260317-2125-README.md (this file)
├── scout-260317-2125-key-findings.md
├── scout-260317-2125-cloud-cli-claude-integration-comparison.md
└── scout-260317-2125-cloud-cli-ppm-file-map.md
```

**Recommended reading order**:
1. This README (orientation)
2. Key Findings (overview + priorities)
3. Comprehensive Comparison (deep dive)
4. File Map (reference during implementation)

