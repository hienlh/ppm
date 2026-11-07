# AGENTS.md

This file provides guidance to AI coding agents (Codex, Antigravity, OpenCode, …) working in this repository.

## Project Overview

**Name:** PPM (Project & Process Manager)
**Type:** TypeScript on Bun
**Description:** A web-based IDE and project manager with AI chat (Claude Agent SDK, Codex and other providers), terminal, git, database tools and file explorer.

## Instructions

The project's instructions live in `CLAUDE.md` and apply to every agent, not only Claude:

- Read the root `CLAUDE.md` before changing code. It covers the dev and production databases, the release process, and gotchas that cost real outages.
- Gotchas confined to one subsystem live in a `CLAUDE.md` inside its directory (`git ls-files '*CLAUDE.md'` lists them). Read the one in the directory you work in.
- Before planning a feature, read `docs/project-roadmap.md`.

## Development Principles

- **YAGNI**: You Aren't Gonna Need It - avoid over-engineering
- **KISS**: Keep It Simple, Stupid - prefer simple solutions
- **DRY**: Don't Repeat Yourself - eliminate code duplication

## Documentation

Keep all important docs in `./docs` folder:

```
./docs
├── project-overview-pdr.md          # Goals, decisions, committed scope
├── project-roadmap.md               # What shipped, what is still open
├── system-architecture.md           # Layer map, protocols, auth, deployment
│   └── architecture/                # Subsystem detail
│       ├── ai-chat-and-providers.md
│       ├── extensions.md
│       ├── data-and-storage.md
│       ├── workspace-and-ui.md
│       └── integrations.md
├── codebase-summary.md              # Directory + module map
├── codebase-subsystems.md           # Subsystem deep dives
├── code-standards.md                # Language and style conventions
├── code-patterns.md                 # PPM-specific implementation patterns
├── design-guidelines.md             # UI framework, mobile-first rules
├── deployment-guide.md              # Install, config, run, release, troubleshoot
├── extension-development-guide.md
└── lessons-learned.md               # Traps that already cost time
```
