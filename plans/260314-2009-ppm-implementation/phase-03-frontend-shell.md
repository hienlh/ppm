# Phase 3: Frontend Shell (Tab System + Layout)

**Owner:** frontend-dev
**Priority:** Critical
**Depends on:** Phase 1
**Effort:** Medium

## Overview

React app shell: tab bar, tab content area, sidebar, mobile navigation. This is the foundation all other UI features plug into.

## Key Insights

- Mobile-first: bottom tab bar on mobile, top tab bar on desktop
- Each tab = lazy-loaded React component
- zustand store manages tab CRUD + active tab
- Sidebar: project list + file explorer (collapsible on mobile)

## UI Design System — "Slate Dark"

See full spec: [UI Style Guide](../reports/researcher-260314-2232-ui-style.md)

### Color Palette
| Token | Hex | Usage |
|-------|-----|-------|
| Background | `#0f1419` | Main app bg (OLED-friendly) |
| Surface | `#1a1f2e` | Cards, panels, modals |
| Surface Elevated | `#252d3d` | Hover states |
| Border | `#404854` | Dividers, input borders |
| Text Primary | `#e5e7eb` | Body text (13.5:1 contrast) |
| Text Secondary | `#9ca3af` | Hints, timestamps |
| Primary Blue | `#3b82f6` | Buttons, active tabs, focus rings |
| Success Green | `#10b981` | Commit, save |
| Error Red | `#ef4444` | Errors, deletions |
| Warning Orange | `#f59e0b` | Conflicts, unsaved |

### Typography
- UI font: **Geist Sans** (Vercel's dev tool font)
- Code font: **Geist Mono** (clear `1lI` distinction, ligatures)
- Default UI text: 14px / weight 400
- Editor: 13px mono
- Terminal: 12px mono

### Component Rules
- Touch targets: **44px minimum** height
- Border radius: 8px default, 12px for cards/modals, 6px for inputs
- **Dual theme:** Dark (default) + Light mode, togglable via settings
- shadcn/ui with custom CSS variables for both themes
- Icon library: **Lucide** (lightweight, works on both themes)
- CodeMirror theme: custom from Slate Dark palette (dark) + custom light variant
- Fonts: Google Fonts CDN (Geist Sans + Geist Mono)
- Notifications: bottom-left toast (desktop), bottom full-width toast (mobile) — one-hand friendly

### Light Theme Palette ("Slate Light")
| Token | Hex | Usage |
|-------|-----|-------|
| Background | `#ffffff` | Main app bg |
| Surface | `#f8fafc` | Cards, panels |
| Surface Elevated | `#f1f5f9` | Hover states |
| Border | `#e2e8f0` | Dividers |
| Text Primary | `#1a1f2e` | Body text |
| Text Secondary | `#64748b` | Hints |
| Primary Blue | `#2563eb` | Buttons, active tabs |
| Success Green | `#059669` | Commit, save |
| Error Red | `#dc2626` | Errors |
| Warning Orange | `#d97706` | Conflicts |

### Theme Toggle
- Store preference in `settings.store.ts` → persisted to localStorage
- Options: "light" | "dark" | "system" (follows OS `prefers-color-scheme`)
- Default: "system"
- Toggle in settings tab + quick toggle icon in top bar / mobile header
- Tailwind `darkMode: 'class'` → toggle `<html class="dark">`
- CodeMirror: switch between custom dark/light theme extensions

### Mobile-Specific
- Bottom nav: 64px height, max 5 tabs, icon + label
- Active tab indicator: top border (blue)
- Drawer sidebar: slide-in overlay with backdrop (not toggle)

## Files to Create

```
src/web/
├── index.html
├── main.tsx                    # React entry + PWA register
├── app.tsx                     # Layout: sidebar + tab area
├── components/
│   ├── layout/
│   │   ├── tab-bar.tsx         # Scrollable tab bar
│   │   ├── tab-content.tsx     # Renders active tab component
│   │   ├── sidebar.tsx         # Project list + file tree
│   │   └── mobile-nav.tsx      # Bottom nav for mobile
│   ├── projects/
│   │   ├── project-list.tsx    # List of registered projects
│   │   └── project-card.tsx    # Single project card
│   └── ui/                     # shadcn/ui (already installed)
├── stores/
│   ├── tab.store.ts            # Tab CRUD + active tab
│   ├── project.store.ts        # Current project + project list
│   └── settings.store.ts       # Theme, layout prefs
├── hooks/
│   └── use-websocket.ts        # Generic WS hook with reconnect
├── lib/
│   ├── api-client.ts           # fetch wrapper for /api/*
│   └── ws-client.ts            # WS client class with reconnect
└── styles/
    └── globals.css             # Tailwind imports + custom vars
```

## Implementation Steps

### 1. Tab Store (zustand)
```typescript
interface Tab {
  id: string;
  type: 'projects' | 'terminal' | 'chat' | 'editor' | 'git-graph' | 'git-status' | 'git-diff' | 'settings';
  title: string;
  metadata?: Record<string, any>; // e.g., filePath for editor, sessionId for chat
  closable: boolean;
}

interface TabStore {
  tabs: Tab[];
  activeTabId: string | null;
  openTab(tab: Omit<Tab, 'id'>): string;  // returns new tab id
  closeTab(id: string): void;
  setActiveTab(id: string): void;
  updateTab(id: string, updates: Partial<Tab>): void;
}
```

### 2. App Layout
```
Desktop:
┌──────────┬────────────────────────────┐
│ Sidebar  │ [Tab1] [Tab2] [Tab3] [+]   │
│ (280px)  ├────────────────────────────┤
│ Projects │                            │
│ Files    │     Active Tab Content      │
│          │                            │
└──────────┴────────────────────────────┘

Mobile:
┌────────────────────────────────────────┐
│ ☰  PPM - Project Name          ⚙️     │
├────────────────────────────────────────┤
│                                        │
│         Active Tab Content             │
│                                        │
├────────────────────────────────────────┤
│ [Projects] [Terminal] [Chat] [Git] [+] │
└────────────────────────────────────────┘
```

### 3. Tab Content (lazy loaded)
```typescript
const TAB_COMPONENTS: Record<Tab['type'], React.LazyExoticComponent<any>> = {
  'projects': lazy(() => import('./projects/project-list')),
  'terminal': lazy(() => import('./terminal/terminal-tab')),
  'chat': lazy(() => import('./chat/chat-tab')),
  'editor': lazy(() => import('./editor/code-editor')),
  'git-graph': lazy(() => import('./git/git-graph')),
  'git-status': lazy(() => import('./git/git-status-panel')),
  'git-diff': lazy(() => import('./git/git-diff-tab')),
  'settings': lazy(() => import('./settings/settings-tab')),
};
```

### 4. API Client
```typescript
class ApiClient {
  constructor(private baseUrl: string, private token?: string)
  async get<T>(path: string): Promise<T>
  async post<T>(path: string, body?: any): Promise<T>
  async delete(path: string): Promise<void>
}
```

### 5. WebSocket Client
```typescript
class WsClient {
  constructor(private url: string)
  connect(): void
  disconnect(): void
  send(data: string | ArrayBuffer): void
  onMessage(handler: (data: MessageEvent) => void): void
  // Auto-reconnect with exponential backoff
  // Heartbeat ping/pong
}
```

### 6. Project List Tab
- Fetch `GET /api/projects` on mount
- Display project cards with name, path, git status indicator
- Click project → set as active, open file explorer in sidebar

### 7. Mobile Responsiveness
- Tailwind breakpoints: `sm:`, `md:`, `lg:`
- Tab bar: bottom on mobile (`fixed bottom-0`), top on desktop
- Touch: swipe left/right to switch tabs (nice-to-have)

### 8. Mobile Drawer Sidebar (`src/web/components/layout/mobile-drawer.tsx`)

**[V2 FIX]** Do NOT use `hidden md:flex` toggle for mobile sidebar. Instead:
- Absolute positioned overlay with backdrop (`fixed inset-0 z-50`)
- Slide-in from left (`translate-x`) with animation
- Click backdrop to close
- Separate from desktop sidebar — desktop uses `hidden md:flex`, mobile uses drawer
- Hamburger button opens drawer, not toggles sidebar visibility

### 9. API Client Auto-Unwrap (`src/web/lib/api-client.ts`)

**[V2 FIX]** Api-client must auto-unwrap `{ok, data}` envelope:
```typescript
async get<T>(path: string): Promise<T> {
  const res = await fetch(`${this.baseUrl}${path}`, { headers });
  const json = await res.json();
  if (json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json.data as T;  // Return unwrapped data directly
}
```

### 10. Auth Login Screen (`src/web/components/auth/login-screen.tsx`)

- Full-screen centered card with token input field + "Unlock" button
- On submit → store token in `localStorage('ppm-auth-token')`
- `api-client` reads token from localStorage for all requests
- On 401 response from any API call → clear token → redirect to login screen
- If server has `auth.enabled: false` → skip login, app loads directly
- Check auth status on app mount: `GET /api/auth/check` → returns `{ ok: true }` or 401

### 11. Tab Metadata for Git Tabs

**[V2 FIX]** Both tab-bar "+" dropdown AND mobile-nav MUST pass `{ projectName: activeProject.name }` when opening git-graph, git-status, git-diff tabs. Without this metadata, git components get `undefined` project.

## Success Criteria

- [ ] App loads in browser with tab bar + sidebar visible
- [ ] Login screen shown when `auth.enabled: true` — entering correct token stores in localStorage and loads app
- [ ] Invalid token shows error message on login screen
- [ ] Can open new tab, close tab, switch between tabs — active tab content renders
- [ ] Opening duplicate tab (same type + metadata) focuses existing tab instead of creating new
- [ ] Project list fetches from API and displays project cards with name and path
- [ ] Clicking project card sets it as active project (zustand store updates)
- [ ] Mobile layout: bottom nav visible on small screens, top tab bar on desktop
- [ ] Mobile drawer: hamburger opens overlay sidebar with backdrop, clicking backdrop closes it
- [ ] Desktop sidebar: always visible at 280px width, collapsible
- [ ] API client auto-unwraps `{ok, data}` envelope — `apiClient.get<Project[]>('/api/projects')` returns `Project[]` directly
- [ ] API client throws error with message when `ok: false` (e.g., 401, 404)
- [ ] WebSocket client connects, auto-reconnects with exponential backoff (1s, 2s, 4s, max 30s)
- [ ] Git tabs opened from BOTH tab-bar AND mobile-nav include `{ projectName }` metadata
- [ ] Theme: dark + light mode both work with proper contrast ratios
- [ ] Theme toggle: "system" default follows OS preference, manual override persists in localStorage
- [ ] CodeMirror editor switches theme when app theme changes
- [ ] Notifications: toast appears bottom-left (desktop), bottom full-width (mobile)
