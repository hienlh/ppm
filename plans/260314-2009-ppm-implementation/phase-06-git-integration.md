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

**[V2 FIX]** Do NOT parse `git log --format` manually with newline separators. Use simple-git's built-in `.log()` which returns correctly typed `LogResult`:

```typescript
async graphData(projectPath: string, maxCount = 200): Promise<GitGraphData> {
  const git = simpleGit(projectPath);

  // Use simple-git's built-in log() — handles parsing correctly
  const log = await git.log({
    '--all': null,
    maxCount,
  });

  // log.all is already typed: { hash, date, message, author_name, author_email, refs, body, diff? }[]
  const commits: GitCommit[] = log.all.map(c => ({
    hash: c.hash,
    abbreviatedHash: c.hash.slice(0, 7),
    subject: c.message,
    body: c.body,
    authorName: c.author_name,
    authorEmail: c.author_email,
    authorDate: c.date,
    parents: [], // Need separate call or parse refs
    refs: c.refs ? c.refs.split(', ').filter(Boolean) : [],
  }));

  // Get parent hashes via raw format (safe: one field per line)
  const parentLog = await git.raw([
    'log', '--all', `--max-count=${maxCount}`,
    '--format=%H %P'  // hash + space-separated parents on ONE line
  ]);
  const parentMap = new Map<string, string[]>();
  for (const line of parentLog.trim().split('\n')) {
    const [hash, ...parents] = line.split(' ');
    if (hash) parentMap.set(hash, parents.filter(Boolean));
  }
  for (const c of commits) {
    c.parents = parentMap.get(c.hash) ?? [];
  }

  const branchSummary = await git.branch(['-a', '--no-color']);
  const branches: GitBranch[] = Object.entries(branchSummary.branches).map(([name, info]) => ({
    name,
    current: info.current,
    remote: name.startsWith('remotes/'),
    commitHash: info.commit,
    ahead: 0,
    behind: 0,
  }));

  return { commits, branches };
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
