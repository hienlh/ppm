# Cloud-CLI vs PPM: File & Component Map

## Cloud-CLI File Structure (Key Files for Claude Integration)

```
cloud-cli/
├── server/
│   ├── claude-sdk.js                    [844 lines] ⭐ CORE
│   │   ├── query() wrapper
│   │   ├── mapCliOptionsToSDK()
│   │   ├── Tool approval workflow
│   │   ├── Session management
│   │   ├── Image handling
│   │   └── Token budget tracking
│   │
│   ├── routes/
│   │   ├── mcp.js                       [MCP server CRUD via CLI]
│   │   │   ├── /api/mcp/cli/list
│   │   │   └── /api/mcp/cli/add
│   │   │
│   │   ├── commands.js                  [Custom command system]
│   │   │   ├── /help, /clear, /model
│   │   │   ├── /memory (CLAUDE.md)
│   │   │   └── /config, /status
│   │   │
│   │   ├── settings.js                  [User settings CRUD]
│   │   │   ├── /api/settings/api-keys
│   │   │   └── /api/settings/credentials
│   │   │
│   │   ├── claude.js / cursor.js / etc  [Multi-provider routes]
│   │   └── agent.js                     [Agent-specific handling]
│   │
│   ├── cursor-cli.js                    [Cursor provider]
│   ├── gemini-cli.js                    [Gemini provider]
│   ├── openai-codex.js                  [Codex provider]
│   ├── sessionManager.js                [Session lifecycle]
│   └── index.js                         [Express server setup]
│
└── shared/
    └── modelConstants.js                [Model definitions]
```

## PPM File Structure (Key Files for Claude Integration)

```
ppm/
├── src/
│   ├── providers/
│   │   └── claude-agent-sdk.ts          [~500 lines] ⭐ CORE
│   │       ├── ClaudeAgentSdkProvider class
│   │       ├── Session management
│   │       ├── Tool approval (simple model)
│   │       └── Token tracking
│   │
│   ├── server/
│   │   ├── ws/
│   │   │   └── chat.ts                  [WebSocket handler]
│   │   │       ├── Message streaming
│   │   │       └── Tool approval bridging
│   │   │
│   │   └── routes/
│   │       ├── chat.ts                  [Chat API endpoints]
│   │       └── (other routes...)
│   │
│   ├── web/
│   │   ├── hooks/
│   │   │   └── use-chat.ts              [Frontend chat state]
│   │   │
│   │   └── components/
│   │       └── chat/                    [Chat UI components]
│   │
│   └── services/
│       └── config.service.ts            [Config file reading]
│           └── ~/.ppm/config.yaml
│
└── CLAUDE.md                            [Project instructions (not used yet)]
```

## Feature Comparison: Line-by-Line

### CLAUDE.md Loading

**Cloud-CLI** (`server/claude-sdk.js:199-206`):
```javascript
sdkOptions.systemPrompt = {
  type: 'preset',
  preset: 'claude_code'  // ← Loads CLAUDE.md
};
sdkOptions.settingSources = ['project', 'user', 'local'];
```

**PPM** (`src/providers/claude-agent-sdk.ts`):
- ❌ Not configured
- Uses config.yaml instead
- CLAUDE.md file exists but unused

---

### Permission Mode Handling

**Cloud-CLI** (`server/claude-sdk.js:144-214`):
```javascript
function mapCliOptionsToSDK(options = {}) {
  // Supports: 'default', 'bypassPermissions', 'acceptEdits', 'auto_edit', 'plan', 'yolo'
  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }
  if (permissionMode === 'plan') {
    planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', ...];
  }
}
```

**PPM** (`src/providers/claude-agent-sdk.ts`):
- Basic approve/deny only
- No multi-mode support
- No plan mode tools

---

### Tool Approval Workflow

**Cloud-CLI** (`server/claude-sdk.js:109-137, 520-601`):
```javascript
// Granular pattern matching
matchesToolPermission(entry, toolName, input)
  - Exact: 'Bash' matches 'Bash' tool
  - Pattern: 'Bash(git:*)' matches 'Bash' with 'git' prefix

// Full approval workflow
canUseTool: async (toolName, input, context) => {
  // 1. Check permission rules
  // 2. Send to UI if needed
  // 3. Wait with timeout (default 55s)
  // 4. Handle decision
}
```

**PPM** (`src/providers/claude-agent-sdk.ts`):
```javascript
// Simple binary: allow or deny
pendingApprovals.set(requestId, resolver);
// No pattern matching
```

---

### MCP Server Management

**Cloud-CLI** (`server/routes/mcp.js`):
```javascript
// CLI-based approach
spawn('claude', ['mcp', 'list'])
spawn('claude', ['mcp', 'add', '--scope', scope, ...])

// Also loads from ~/.claude.json in SDK
```

**PPM**:
- ❌ No MCP management UI
- Relies on Claude Code's defaults
- Config-driven (config.yaml)

---

### Custom Commands

**Cloud-CLI** (`server/routes/commands.js`):
```javascript
// 8 built-in commands
const builtInCommands = [
  { name: '/help', description: '...' },
  { name: '/memory', description: 'Open CLAUDE.md...' },
  { name: '/config', description: '...' },
  // + 5 more
]

// Dynamic custom command discovery
scanCommandsDirectory(dir)  // Reads .claude/commands/
// Supports project-level and user-level commands
```

**PPM**:
- ❌ No command system
- Simple chat interface only

---

### Session Persistence

**Cloud-CLI** (`server/claude-sdk.js:223-257`):
```javascript
// In-memory tracking
activeSessions.set(sessionId, {
  instance: queryInstance,
  startTime: Date.now(),
  status: 'active',
  tempImagePaths: [],
  tempDir: null
})

// Cleanup on completion
removeSession(sessionId)
```

**PPM** (`src/providers/claude-agent-sdk.ts`):
```javascript
// Persistent file-based mapping
const SESSION_MAP_FILE = resolve(homedir(), ".ppm", "session-map.json");
saveSessionMapping(ppmId, sdkId)  // Survives restarts
```

---

### Image Upload Support

**Cloud-CLI** (`server/claude-sdk.js:323-369`):
```javascript
async handleImages(command, images, cwd) {
  // 1. Create temp directory
  // 2. Decode base64 images
  // 3. Save to disk
  // 4. Modify prompt with file paths
  // 5. Return for cleanup
}
```

**PPM**:
- ❌ No image upload yet

---

## Multi-Provider Architecture

**Cloud-CLI** (`server/routes/`):
```
├── claude.js      (SDK-based)
├── cursor.js      (Cursor CLI)
├── gemini.js      (Gemini CLI)
└── openai-codex.js (CodeX)

Each with own:
- Query handler
- Permission mapping
- Token pricing
- Model selection
```

**PPM**:
- Claude only
- Interface-based extensibility planned

---

## Configuration Sources

**Cloud-CLI**:
1. `~/.claude.json` (global MCP servers)
2. `~/.claude/commands/` (user commands)
3. `./.claude/commands/` (project commands)
4. Per-session tool settings in database

**PPM**:
1. `~/.ppm/config.yaml` (or config.dev.yaml for dev)
2. CLAUDE.md (exists but unused)
3. In-memory session tracking

---

## WebSocket Message Types

**Cloud-CLI** (`server/claude-sdk.js`):
```javascript
// Sent to client:
- 'claude-response'          // SDK message
- 'token-budget'             // Usage tracking
- 'claude-complete'          // Completion
- 'claude-error'             // Error
- 'claude-permission-request' // Needs approval
- 'session-created'          // New session ID

// Received from client:
- 'claude-permission-response' // Tool approval
```

**PPM** (`src/server/ws/chat.ts`):
```javascript
// Similar pattern but simpler:
- 'claude-response'
- 'token-budget'
- 'claude-complete'
- 'claude-error'
- (approval responses)
```

---

## SDK Configuration Options

### Cloud-CLI Full Mapping (`mapCliOptionsToSDK`)
```javascript
{
  cwd,                          // Working directory
  permissionMode,               // 5+ modes
  allowedTools,                 // Include list
  disallowedTools,              // Exclude list
  model,                        // Model selection
  systemPrompt: {               // CLAUDE.md loading
    type: 'preset',
    preset: 'claude_code'
  },
  settingSources,               // ['project', 'user', 'local']
  mcpServers,                   // Loaded from ~/.claude.json
  tools: {
    type: 'preset',
    preset: 'claude_code'       // All default tools
  },
  hooks: {                      // Notification hooks
    Notification: [...]
  },
  canUseTool                    // Tool approval callback
}
```

### PPM Minimal Mapping
```javascript
{
  cwd,
  permissionMode,              // Just 'default'/'bypassPermissions'
  model,
  tools,
  // Missing:
  // - systemPrompt (CLAUDE.md)
  // - settingSources
  // - hooks
  // - pattern matching
}
```

---

## Key Takeaway

| Aspect | Cloud-CLI | PPM | Gap |
|--------|-----------|-----|-----|
| **Lines of SDK code** | 844 | ~500 | PPM is leaner |
| **Permission modes** | 6+ | 1 | Cloud-CLI more flexible |
| **CLAUDE.md support** | ✅ Full | ❌ None | Core gap |
| **Custom commands** | ✅ 8 built-in | ❌ None | UX gap |
| **MCP UI** | ✅ Full CRUD | ❌ None | Power-user gap |
| **Session persistence** | In-memory | File-based | PPM more resilient |
| **Multi-provider** | ✅ 4 providers | Claude only | Scope difference |
| **Image upload** | ✅ Base64→temp | ❌ None | UX gap |

