# Phase 6: Git Integration

**Owner:** backend-dev (API) + frontend-dev (UI) — parallel
**Priority:** High
**Depends on:** Phase 4 (file explorer, diff viewer reuse)
**Effort:** Large (git graph is complex)

## Overview

Git status panel (stage/unstage/commit/push/pull), git diff viewer, git graph visualization (SVG, ported from vscode-git-graph approach).

## Backend (backend-dev)

### Files
```
src/services/git.service.ts
src/server/routes/git.ts
```

### Git Service
```typescript
import simpleGit from 'simple-git';

class GitService {
  // Status
  async status(projectPath: string): Promise<GitStatus>
  async diff(projectPath: string, ref1?: string, ref2?: string): Promise<string> // unified diff
  async fileDiff(projectPath: string, filePath: string): Promise<string>

  // Staging
  async stage(projectPath: string, files: string[]): Promise<void>
  async unstage(projectPath: string, files: string[]): Promise<void>

  // Commit + Push/Pull
  async commit(projectPath: string, message: string): Promise<string> // returns hash
  async push(projectPath: string, remote?: string, branch?: string): Promise<void>
  async pull(projectPath: string, remote?: string, branch?: string): Promise<void>

  // Branch ops
  async branches(projectPath: string): Promise<GitBranch[]>
  async createBranch(projectPath: string, name: string, from?: string): Promise<void>
  async checkout(projectPath: string, ref: string): Promise<void>
  async deleteBranch(projectPath: string, name: string, force?: boolean): Promise<void>
  async merge(projectPath: string, source: string): Promise<void>

  // Graph data
  async graphData(projectPath: string, maxCount?: number): Promise<GitGraphData>

  // Advanced (web-only, no CLI needed)
  async cherryPick(projectPath: string, hash: string): Promise<void>
  async revert(projectPath: string, hash: string): Promise<void>
  async createTag(projectPath: string, name: string, hash?: string): Promise<void>

  // PR URL
  getCreatePrUrl(projectPath: string, branch: string): string | null
  // Parse remote URL → GitHub/GitLab PR creation URL
}
```

### Graph Data Extraction
```typescript
async graphData(projectPath: string, maxCount = 500): Promise<GitGraphData> {
  const git = simpleGit(projectPath);

  // Custom format similar to vscode-git-graph's dataSource.ts
  const log = await git.log({
    '--all': null,
    '--max-count': maxCount,
    '--format': '%H%n%P%n%an%n%ae%n%at%n%s', // hash, parents, author, email, timestamp, subject
  });

  const branches = await git.branch(['-a', '--no-color']);
  const tags = await git.tags();

  // Lane allocation algorithm (server-side for performance)
  const lanes = allocateLanes(log.all);

  return { commits: log.all, branches, tags, lanes, HEAD: await git.revparse(['HEAD']) };
}
```

### Lane Allocation Algorithm
Port from vscode-git-graph `web/graph.ts`:
- Each branch gets a lane (column index)
- Merge/fork lines connect lanes
- Color = `laneIndex % colorPalette.length`
- Return: `Map<commitHash, { lane: number, lines: Line[] }>`

### API Routes
```
GET  /api/git/status/:project
GET  /api/git/diff/:project?ref1=&ref2=
GET  /api/git/file-diff/:project?file=&ref=
GET  /api/git/graph/:project?max=500
GET  /api/git/branches/:project
POST /api/git/stage             { project, files }
POST /api/git/unstage           { project, files }
POST /api/git/commit            { project, message }
POST /api/git/push              { project, remote?, branch? }
POST /api/git/pull              { project, remote?, branch? }
POST /api/git/branch/create     { project, name, from? }
POST /api/git/checkout          { project, ref }
POST /api/git/branch/delete     { project, name, force? }
POST /api/git/merge             { project, source }
POST /api/git/cherry-pick       { project, hash }
POST /api/git/revert            { project, hash }
POST /api/git/tag               { project, name, hash? }
GET  /api/git/pr-url/:project?branch=  → { url }
```

## Frontend (frontend-dev)

### Files
```
src/web/components/git/git-graph.tsx
src/web/components/git/git-graph-renderer.tsx
src/web/components/git/git-status-panel.tsx
src/web/components/git/git-diff-tab.tsx
src/web/components/git/commit-context-menu.tsx
src/web/lib/git-graph-layout.ts
```

### Git Status Panel
- Split into: Changes (unstaged) + Staged Changes
- Each file: icon (M/A/D/R), filename, click → open diff
- Buttons: Stage All, Unstage All
- Individual file: click +/- to stage/unstage
- Commit section: textarea input + "Commit" button
- Push/Pull buttons with branch name display
- Auto-refresh via WS `/ws/events` or polling

### Git Graph (SVG)
```typescript
// git-graph-renderer.tsx
// Receives: commits + lanes from backend API

const GitGraphRenderer = ({ data }: { data: GitGraphData }) => {
  // SVG element with:
  // 1. Branch lines: <path> elements, curved or angular
  // 2. Commit nodes: <circle> elements
  // 3. Labels: branch names, tags as badges
  // 4. Click handlers on commits → expand details
  // 5. Context menu on commits and branches

  // Virtualization: only render visible rows
  // Each commit row height = GRID_Y (e.g., 24px)
  // Scroll container with virtual list
};
```

### Git Graph Context Menu (shadcn/ui ContextMenu)
**On commit node:**
- Checkout this commit
- Create branch here...
- Cherry pick
- Revert
- Create tag...
- Copy commit hash
- View diff

**On branch label:**
- Checkout
- Merge into current branch
- Delete branch
- Rename branch
- Push
- Pull
- Rebase onto current
- Create Pull Request → opens browser URL

### Git Diff Tab
- Reuse `@codemirror/merge` diff viewer from Phase 4
- Opened from: git status (click file), git graph (view diff), file explorer (compare)
- Header: file path, ref1 vs ref2

## Success Criteria

- [ ] Git status panel shows changed/staged files
- [ ] Can stage, unstage, commit, push, pull from UI
- [ ] Git graph renders commit history with colored lanes
- [ ] Context menu works on commits and branches
- [ ] Branch operations (create, checkout, delete, merge) work
- [ ] "Create PR" opens correct GitHub/GitLab URL in browser
- [ ] Diff view shows file changes
- [ ] Works on mobile (scrollable graph, touch context menu)
