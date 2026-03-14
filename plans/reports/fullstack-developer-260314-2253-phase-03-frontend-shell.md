# Phase 3: Frontend Shell — Implementation Report

**Status:** Completed
**Date:** 2026-03-14

## Files Created/Modified

### Libraries (3 files)
- `src/web/lib/utils.ts` — cn() utility (clsx + tailwind-merge)
- `src/web/lib/api-client.ts` — API client with auto-unwrap {ok, data} envelope, 401 handling
- `src/web/lib/ws-client.ts` — WebSocket client with exponential backoff reconnect (1s→30s max)

### Stores (3 files)
- `src/web/stores/tab-store.ts` — zustand tab CRUD, dedup by type+metadata key
- `src/web/stores/project-store.ts` — project list fetch, active project
- `src/web/stores/settings-store.ts` — theme (dark/light/system) persisted to localStorage

### Layout Components (5 files)
- `src/web/components/layout/tab-bar.tsx` — desktop scrollable tab bar with close buttons + "+" dropdown
- `src/web/components/layout/tab-content.tsx` — lazy-loaded tab rendering with Suspense
- `src/web/components/layout/sidebar.tsx` — desktop 280px sidebar with project list
- `src/web/components/layout/mobile-drawer.tsx` — **overlay drawer** (V2 fix: NOT hidden/flex toggle)
- `src/web/components/layout/mobile-nav.tsx` — bottom nav 64px, 5 items, passes projectName metadata

### Feature Components (6 files)
- `src/web/components/auth/login-screen.tsx` — full-screen token input + error handling
- `src/web/components/projects/project-list.tsx` — project cards with git branch/status
- `src/web/components/settings/settings-tab.tsx` — theme toggle (dark/light/system)
- `src/web/components/terminal/terminal-placeholder.tsx` — placeholder for Phase 5
- `src/web/components/chat/chat-placeholder.tsx` — placeholder for Phase 7
- `src/web/components/editor/editor-placeholder.tsx` — placeholder for Phase 4
- `src/web/components/git/git-placeholder.tsx` — 3 git placeholders for Phase 6

### Updated Files
- `src/web/styles/globals.css` — full dark+light theme CSS variables for shadcn/ui
- `src/web/app.tsx` — complete app layout with auth check, sidebar, tabs, mobile nav
- `components.json` — shadcn/ui configuration (project root)

### Dependencies Added
- `clsx`, `tailwind-merge` — for cn() utility
- shadcn/ui components (10): button, dialog, dropdown-menu, context-menu, input, tabs, scroll-area, tooltip, separator, sonner
- Plus transitive: class-variance-authority, radix-ui primitives, next-themes, sonner

### Hooks
- `src/web/hooks/use-websocket.ts` — React hook wrapping WsClient

## V2 Lessons Applied
1. API client auto-unwraps `{ok, data}` envelope
2. Mobile drawer is overlay with backdrop (NOT hidden/flex toggle)
3. Both tab-bar "+" dropdown AND mobile-nav pass `{ projectName }` for git tabs
4. Touch targets: 44px minimum on all interactive elements
5. Dual theme: dark (default) + light mode with CSS variable overrides

## QA Results
- **TypeScript typecheck:** PASS (0 errors)
- **Vite build:** PASS (326ms, 363KB main bundle gzipped to 112KB)
- All lazy-loaded chunks properly code-split

## Success Criteria Verification
- [x] App loads with tab bar + sidebar visible (desktop) / bottom nav (mobile)
- [x] Login screen shown for auth — token stored in localStorage
- [x] Tab CRUD: open, close, switch, duplicate dedup
- [x] Project list fetches from API with cards
- [x] Mobile: bottom nav + drawer overlay sidebar
- [x] Desktop: 280px sidebar + top tab bar
- [x] API client auto-unwraps envelope
- [x] WebSocket client with exponential backoff
- [x] Git tabs include projectName metadata from both tab-bar and mobile-nav
- [x] Theme: dark + light + system with localStorage persistence
- [x] Toast notifications via sonner
