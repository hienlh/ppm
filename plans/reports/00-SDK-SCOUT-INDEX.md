# Claude Agent SDK Integration - Scout Report Index

**Generated:** March 15, 2026  
**Scout:** Codebase Scout Agent  
**Project:** PPM (Project & Process Manager)  
**Task:** Complete inventory of @anthropic-ai/claude-agent-sdk integration  

---

## Report Files

### 1. SCOUT-SUMMARY.md (Executive Summary)
**Purpose:** Quick reference and file paths  
**Size:** 12 KB  
**Read Time:** 10 minutes  

**Contains:**
- Quick reference with absolute file paths
- What's implemented vs NOT implemented
- How messages flow (user → SDK → frontend)
- SDK query options explained
- Key takeaways and architecture strengths
- Files summary table
- Next steps for extending SDK

**Start here if:** You need a quick overview or file paths to read

---

### 2. scout-260315-1911-sdk-integration-inventory.md (Comprehensive Inventory)
**Purpose:** Deep inventory of all SDK features and implementation details  
**Size:** 18 KB  
**Read Time:** 30 minutes  

**Contains:**
- Executive summary
- Core implementation files (detailed breakdown)
  - Provider (claude-agent-sdk.ts)
  - WebSocket handler (chat.ts)
  - Chat service
  - Frontend hook
  - HTTP routes
  - Type definitions
- Type definitions with code
- Provider registry
- Skills & commands discovery
- Usage rate-limits
- Test coverage (unit + integration)
- Data flow examples
- Configuration & environment
- Known limitations & gotchas
- Summary statistics
- Features implemented ✅
- Features NOT implemented ❌

**Start here if:** You need deep technical understanding of each component

---

### 3. sdk-integration-architecture.md (Architecture & Flows)
**Purpose:** Visual system design and message flow documentation  
**Size:** 21 KB  
**Read Time:** 25 minutes  

**Contains:**
- System overview diagram
- Message flow: Single Query (9 steps)
- Message flow: Tool Execution
- Message flow: Approval (AskUserQuestion)
- Multi-turn conversation
- Event type mapping (SDK → Provider → WS → FE)
- State machine: useChat Message Accumulation
- Error handling paths
- File organization
- Key integration points
- Summary layer table

**Start here if:** You need to understand message flows or modify event handling

---

### 4. sdk-file-inventory.md (File Catalog)
**Purpose:** Detailed file-by-file catalog with dependencies  
**Size:** 13 KB  
**Read Time:** 20 minutes  

**Contains:**
- Core SDK integration files (8 files, 1739 LOC)
- Supporting services (2 files, 299 LOC)
- Testing files (6 files, 573 LOC)
- Frontend components (4 files)
- Configuration & setup files
- Data flow integration points
- Dependency map
- Summary table
- Exposed endpoints (WebSocket + HTTP)
- Key concepts
- Unresolved questions

**Start here if:** You need to understand file organization and dependencies

---

## Quick Navigation

### For Different Use Cases

#### "I need to understand what's implemented"
→ Read: **SCOUT-SUMMARY.md** (sections: "What's Implemented", "What's NOT Implemented")

#### "I need to modify SDK query options"
→ Read: **scout-260315-1911-sdk-integration-inventory.md** (section: "1. Provider: Claude Agent SDK")  
→ File: `/Users/hienlh/Projects/ppm/src/providers/claude-agent-sdk.ts` lines 209-235

#### "I need to understand message flow"
→ Read: **sdk-integration-architecture.md** (sections: "Message Flow: Single Query", "Message Flow: Tool Execution", "Message Flow: Approval")

#### "I need to add a new tool"
→ Read: **SCOUT-SUMMARY.md** (section: "Next Steps to Extend SDK")  
→ File: `/Users/hienlh/Projects/ppm/src/providers/claude-agent-sdk.ts` line 226

#### "I need to modify approval workflow"
→ Read: **sdk-integration-architecture.md** (section: "Message Flow: Approval")  
→ File: `/Users/hienlh/Projects/ppm/src/providers/claude-agent-sdk.ts` lines 171-204

#### "I need to understand WebSocket protocol"
→ Read: **scout-260315-1911-sdk-integration-inventory.md** (section: "2. WebSocket Chat Handler")  
→ File: `/Users/hienlh/Projects/ppm/src/server/ws/chat.ts`

#### "I need to find all SDK-related files"
→ Read: **sdk-file-inventory.md** (section: "Files Summary Table")  
→ Also: **SCOUT-SUMMARY.md** (section: "Quick Reference: All SDK-Related Files")

#### "I need to understand event types"
→ Read: **sdk-integration-architecture.md** (section: "Event Type Mapping")  
→ File: `/Users/hienlh/Projects/ppm/src/types/chat.ts`

---

## File References

### All SDK-Related Source Files

**Core (Read these first):**
1. `/Users/hienlh/Projects/ppm/src/providers/claude-agent-sdk.ts` (512 LOC) — SDK integration
2. `/Users/hienlh/Projects/ppm/src/server/ws/chat.ts` (146 LOC) — WebSocket handler
3. `/Users/hienlh/Projects/ppm/src/web/hooks/use-chat.ts` (424 LOC) — React hook

**Supporting:**
4. `/Users/hienlh/Projects/ppm/src/services/chat.service.ts` (111 LOC) — Provider routing
5. `/Users/hienlh/Projects/ppm/src/server/routes/chat.ts` (154 LOC) — HTTP endpoints
6. `/Users/hienlh/Projects/ppm/src/types/chat.ts` (93 LOC) — Type definitions
7. `/Users/hienlh/Projects/ppm/src/providers/registry.ts` (46 LOC) — Provider registry
8. `/Users/hienlh/Projects/ppm/src/services/slash-items.service.ts` (185 LOC) — Skills discovery
9. `/Users/hienlh/Projects/ppm/src/services/claude-usage.service.ts` (114 LOC) — Rate limits

**Tests:**
10. `/Users/hienlh/Projects/ppm/tests/unit/providers/claude-agent-sdk.test.ts` (340 LOC)
11. `/Users/hienlh/Projects/ppm/tests/integration/claude-agent-sdk-integration.test.ts` (233 LOC)

---

## Key Concepts at a Glance

### Session Management
- **First message:** `query({ options: { sessionId: uuid } })`
- **Subsequent messages:** `query({ options: { resume: sessionId } })`
- **Persistence:** SDK manages `~/.claude/projects/<cwd>/<sessionId>/`
- **Loading history:** Via `getSessionMessages(sessionId)`

### Event Flow
```
SDK yields events → Provider transforms → WS sends JSON → Frontend receives
```

### Approval Workflow
```
canUseTool() → yield approval_request → await FE response → resume SDK
```

### Tool Execution
```
SDK auto-executes → Yields tool_use → Fetches tool_result → Yields result
```

### Rate Limits
```
SDK yields rate_limit_event → Provider caches → WS sends → FE displays
```

---

## Statistics

| Metric | Value |
|--------|-------|
| **Total Lines of Code** | 1,739 (core) |
| **Report Pages** | 4 |
| **Report Size** | 64 KB total |
| **Files Documented** | 11 |
| **SDK Features Used** | 13+ |
| **Event Types** | 7 |
| **HTTP Endpoints** | 9 |
| **Integration Points** | 5 major |

---

## Document Structure

```
00-SDK-SCOUT-INDEX.md (this file)
├── Report Files (4 documents)
├── Quick Navigation
├── File References
├── Key Concepts
└── Statistics

SCOUT-SUMMARY.md
├── Quick Reference
├── Implemented Features
├── Not Implemented
├── How Messages Flow
├── SDK Query Options
└── Key Takeaways

scout-260315-1911-sdk-integration-inventory.md
├── Executive Summary
├── Core Implementation (8 files)
├── Supporting Services
├── Testing
├── Data Flow Examples
├── Configuration & Environment
└── Known Limitations

sdk-integration-architecture.md
├── System Overview
├── Message Flow Diagrams
├── Event Type Mapping
├── State Machine
├── Error Handling
├── File Organization
└── Integration Points

sdk-file-inventory.md
├── Core Files
├── Supporting Services
├── Testing Files
├── Dependency Map
├── Exposed Endpoints
└── Key Concepts
```

---

## How to Use These Reports

### Step 1: Get Oriented
Read: **SCOUT-SUMMARY.md** (10 min)  
→ Understand what's built, what's missing, overview of flow

### Step 2: Understand Architecture
Read: **sdk-integration-architecture.md** (25 min)  
→ Study message flows, event types, error handling

### Step 3: Deep Dive on Component
Read: **scout-260315-1911-sdk-integration-inventory.md** (30 min)  
→ Get detailed breakdown of specific component you need to modify

### Step 4: Find Implementation Details
Read: **sdk-file-inventory.md** (20 min)  
→ Locate files, understand dependencies, find line numbers

### Step 5: Read Actual Code
Open actual files from `/Users/hienlh/Projects/ppm/src/` → Use reports as guide

---

## Unresolved Questions (Gaps)

1. **Approval Timeout** — Currently infinite wait if FE disconnects
2. **Tool Retry** — No automatic retry on failure
3. **Session Cleanup** — Disk storage never cleaned (memory only)
4. **MCP Servers** — Not supported (not exposed in SDK options)
5. **Subagents** — No Task tool or delegation support
6. **Streaming Export** — No save-to-file functionality

---

## Next Actions

### To Extend SDK Features
1. Read: **SCOUT-SUMMARY.md** section "Next Steps to Extend SDK"
2. Read: **scout-260315-1911-sdk-integration-inventory.md** section for your component
3. Find exact line numbers in file reference section
4. Modify files following patterns in tests

### To Debug an Issue
1. Read: **sdk-integration-architecture.md** to find which flow is involved
2. Trace through message flow diagram
3. Check error handling paths
4. Read relevant test case in unit/integration tests

### To Understand a Feature
1. Check **SCOUT-SUMMARY.md** "What's Implemented" ✅
2. Find component in **sdk-file-inventory.md**
3. Read detailed section in **scout-260315-1911-sdk-integration-inventory.md**
4. Study test case in **tests/**

---

## Contact & Updates

**Scout Completed:** March 15, 2026, 19:15  
**Codebase Size:** ~2,800 LOC (SDK integration)  
**Quality:** ✅ Production-grade implementation with tests  

---

Generated by: Codebase Scout Agent  
For: PPM Project Documentation  
Format: Markdown (importable to any wiki/doc system)
