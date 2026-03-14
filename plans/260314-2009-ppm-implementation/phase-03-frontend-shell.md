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
- Sidebar: hidden on mobile, toggle via hamburger menu
- Tab bar: bottom on mobile (`fixed bottom-0`), top on desktop
- Touch: swipe left/right to switch tabs (nice-to-have)

## Success Criteria

- [ ] App loads in browser with tab bar + sidebar
- [ ] Can open/close/switch tabs
- [ ] Project list fetches from API and displays
- [ ] Mobile layout works (bottom nav, collapsible sidebar)
- [ ] API client works with auth token
- [ ] WebSocket client connects and auto-reconnects
