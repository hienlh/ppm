# Phase 8: CLI Commands

**Owner:** backend-dev
**Priority:** Medium
**Depends on:** Phase 2, Phase 6, Phase 7
**Effort:** Medium

## Overview

Implement remaining CLI commands that call Service Layer directly. All commands share project resolution logic (CWD auto-detect + `-p` flag).

## Files
```
src/cli/commands/projects.ts
src/cli/commands/config.ts
src/cli/commands/git.ts
src/cli/commands/chat.ts
```

## Commands

### ppm projects
```bash
ppm projects list                     # Table: name, path, branch, status
ppm projects add <path> [--name <n>]  # Add project to config
ppm projects remove <name-or-path>    # Remove from config
```

### ppm config
```bash
ppm config get <key>                  # e.g., ppm config get port
ppm config set <key> <value>          # e.g., ppm config set port 9090
```

### ppm git
All git commands accept `-p <project>` flag. Default: CWD auto-detect.

```bash
ppm git status [-p proj]              # Show status (like git status --short)
ppm git log [-p proj] [-n 20]         # Show recent commits
ppm git diff [-p proj] [ref1] [ref2]  # Show diff
ppm git stage [-p proj] <files...>    # Stage files (or "." for all)
ppm git unstage [-p proj] <files...>  # Unstage files
ppm git commit [-p proj] -m "msg"     # Commit staged changes
ppm git push [-p proj]                # Push to remote
ppm git pull [-p proj]                # Pull from remote
ppm git branch create [-p proj] <name> [--from <ref>]
ppm git branch checkout [-p proj] <name>
ppm git branch delete [-p proj] <name> [--force]
ppm git branch merge [-p proj] <source>
```

### ppm chat
```bash
ppm chat list [-p proj]                            # List sessions (table: id, provider, title, date)
ppm chat create [-p proj] [--provider claude]      # Create session, print session ID
ppm chat send [-p proj] <session-id> "message"     # Send message, stream response to stdout
ppm chat resume [-p proj] <session-id>             # Interactive mode (stdin/stdout)
ppm chat delete [-p proj] <session-id>             # Delete session
```

`ppm chat send` streams response to stdout as it arrives. Useful for AI-to-AI orchestration:
```bash
# AI agent sends a task to PPM chat
RESPONSE=$(ppm chat send -p myapp abc123 "Fix the bug in auth.ts")
```

`ppm chat resume` enters interactive mode:
```
You: Fix the auth bug
Claude: I'll read the file...
[Tool: Read auth.ts] Allow? (y/n): y
Claude: Found the issue...
You:
```

## Implementation Pattern

All commands follow same pattern:
```typescript
// commands/git.ts
import { Command } from 'commander';

export function registerGitCommands(program: Command) {
  const git = program.command('git').description('Git operations');

  git.command('status')
    .option('-p, --project <name>', 'Project name')
    .action(async (options) => {
      const project = resolveProject(options);
      const gitService = new GitService();
      const status = await gitService.status(project.path);
      // Pretty print to terminal
      printGitStatus(status);
    });

  // ... more subcommands
}
```

## Output Formatting

- Use colors (via `chalk` or Bun built-in ANSI) for terminal output
- Tables for list commands (projects list, chat list)
- Git status: colored M/A/D indicators like git
- Streaming output for chat send

## Success Criteria

**Project Resolution:**
- [ ] `-p myproject` flag resolves project by name
- [ ] No `-p` flag + CWD inside registered project → auto-detects
- [ ] No `-p` flag + CWD not in any project → clear error: "Not in a registered project. Use -p <name>"

**ppm projects:**
- [ ] `ppm projects list` → formatted table with columns: Name, Path, Branch, Status
- [ ] `ppm projects add /path/to/repo --name myrepo` → adds project, confirms with message
- [ ] `ppm projects add` with duplicate name → error message
- [ ] `ppm projects remove myrepo` → removes, confirms with message

**ppm config:**
- [ ] `ppm config get port` → prints current port value
- [ ] `ppm config set port 9090` → updates config file, confirms
- [ ] `ppm config get nonexistent` → error message

**ppm git:**
- [ ] `ppm git status` → colored output matching git status --short format (M=yellow, A=green, D=red)
- [ ] `ppm git log -n 5` → shows last 5 commits with hash, message, author, date
- [ ] `ppm git stage .` → stages all files, prints count
- [ ] `ppm git commit -m "test"` → creates commit, prints hash
- [ ] `ppm git commit` with nothing staged → "Nothing to commit" error
- [ ] `ppm git push` → pushes to remote, prints result
- [ ] `ppm git branch create feature-x` → creates branch, confirms
- [ ] `ppm git branch checkout feature-x` → switches branch, confirms
- [ ] `ppm git branch delete feature-x` → deletes branch, confirms

**ppm chat:**
- [ ] `ppm chat list` → table with columns: ID, Provider, Title, Date
- [ ] `ppm chat create` → creates session, prints session ID
- [ ] `ppm chat send <id> "fix the bug"` → streams response to stdout in real-time
- [ ] `ppm chat resume <id>` → interactive mode with `You:` / `Claude:` prompts
- [ ] Tool approval in interactive mode: `[Tool: Bash] Allow? (y/n):` prompt
- [ ] `ppm chat delete <id>` → deletes session, confirms
