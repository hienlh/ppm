# PPM Design Guidelines

## Design Philosophy

**PPM** prioritizes **clarity, efficiency, and accessibility** over decoration. The UI should feel lightweight, responsive, and get out of the way of actual development work.

**Core Principles:**
1. **Mobile-first** — Design for small screens, scale up
2. **Dark-mode default** — Reduce eye strain during long coding sessions
3. **Minimal chrome** — Maximize editor/terminal space
4. **Keyboard-friendly** — Power users prefer shortcuts
5. **Accessible** — WCAG 2.1 AA compliance
6. **Consistent** — Reuse patterns across features

---

## Mobile-First UI Rules (MANDATORY)

These rules MUST be followed when creating or modifying any UI component. PPM is primarily used on phones and tablets.

### 1. Dialogs → Bottom Sheet on Mobile
- **NEVER** use `<Dialog>` alone. All dialogs MUST render as bottom sheets on mobile (`md:` breakpoint).
- Desktop (`md:` and above): centered dialog is fine
- Mobile (below `md:`): full-width bottom sheet, slides up from bottom, max-height 85vh, rounded top corners
- Pattern: use `hidden md:block` for desktop dialog, `md:hidden` for mobile bottom sheet, or a responsive wrapper

### 2. No Hover States on Touch Devices
- **NEVER** rely on `hover:` for essential interactions or information disclosure
- Hover states are acceptable for desktop enhancement but must have a touch alternative
- Use `active:` or `pressed` states for touch feedback instead
- Action buttons hidden behind `hover:` MUST use the `can-hover:` variant (defined in `globals.css` via `@media (hover: hover) and (pointer: fine)`)
- Pattern: `can-hover:opacity-0 can-hover:group-hover:opacity-100` — buttons visible on touch devices, hover-reveal on mouse devices
- For `hidden`/`flex` toggles: `flex can-hover:hidden can-hover:group-hover:flex`
- **DO NOT** use `md:opacity-0 md:group-hover:opacity-100` — iPad matches `md:` but has no hover

### 3. Touch Targets
- Minimum touch target: **44×44px** (Apple HIG)
- Minimum spacing between interactive elements: **8px**
- Prefer `py-3 px-4` over `py-1 px-2` for buttons on mobile
- Icon-only buttons: minimum `size-10` (40px) with padding

### 4. Context Menus → Long-Press or Inline Actions
- **NEVER** use right-click context menus as the only way to access actions on mobile
- Use long-press (400ms) with `select-none` to prevent text selection
- Or show inline action buttons that are always visible on mobile
- Pattern: `useLongPress` hook for touch, `onContextMenu` for desktop

### 5. Scrolling & Overflow
- Lists MUST scroll independently, not the whole page
- Use `overflow-y-auto` on scroll containers, not on body
- Avoid horizontal scroll unless explicitly needed (tab bars)
- Test that touch scrolling doesn't accidentally trigger tap actions

### 6. Text & Spacing
- Body text: minimum `text-sm` (14px) on mobile, `text-xs` (12px) only for metadata/labels
- Line spacing: `leading-relaxed` for readability on small screens
- Padding: `p-4` minimum for content areas on mobile, `p-2` acceptable for compact lists

### 7. Layout Patterns
- Mobile: single-column layout, full-width components
- Desktop: multi-column, sidebars, split views
- Use `flex-col md:flex-row` for responsive layouts
- Sidebar content → drawer/bottom sheet on mobile

### 8. Forms
- Input fields: full width on mobile (`w-full`)
- Labels above inputs, not beside (saves horizontal space)
- Use native `<select>` or bottom sheet pickers on mobile, not custom dropdowns
- Auto-focus first input on dialog/sheet open

### 9. Thumb Zone — One-Handed Reachability
- Primary actions (submit, confirm, navigate) MUST be in the **bottom 1/3** of the screen on mobile
- Navigation bars → bottom, not top
- Destructive/secondary actions can be in upper areas (harder to reach = harder to accidentally tap)
- FABs (floating action buttons) → bottom-right corner
- Avoid placing frequently-used buttons in top corners — unreachable with one thumb
```
┌─────────────────────┐
│  ❌ Hard to reach    │  ← Secondary/rare actions only
│                     │
├─────────────────────┤
│  ⚠️ Stretch zone    │  ← Content, read-only info
│                     │
├─────────────────────┤
│  ✅ Thumb zone       │  ← Primary actions, navigation,
│  Submit, confirm,   │     inputs, frequently-used buttons
│  tab bar, FAB       │
└─────────────────────┘
```

### 10. Existing Patterns to Follow
- `MobileDrawer` (`src/web/components/layout/mobile-drawer.tsx`) — slide-in drawer for sidebar
- `ProjectBottomSheet` (`src/web/components/layout/project-bottom-sheet.tsx`) — bottom sheet pattern
- `useLongPress` in `git-status-panel.tsx` — long-press for context menus
- `hidden md:block` / `md:hidden` — responsive show/hide pattern

---

## UI Framework Stack

### Tailwind CSS 4.2
- Utility-first CSS framework
- Dark mode support (class-based: `dark:` prefix)
- Responsive breakpoints (`sm:`, `md:`, `lg:`, `xl:`, `2xl:`)
- Custom configuration in `tailwind.config.ts`

### Radix UI 1.4.3
- Unstyled, accessible components
- Provides accessibility (ARIA, keyboard navigation)
- Examples: Dialog, Dropdown, Tooltip, Tabs
- No CSS imports; styled with Tailwind

### shadcn/ui (New York Style)
- Pre-built Radix components with Tailwind styling
- Copy-paste component library (not npm-installed)
- Located in `src/web/components/ui/`
- Customizable and maintainable

### Lucide Icons
- Clean, consistent icon set
- 600+ icons available
- Usage: `import { FileIcon, FolderIcon } from "lucide-react"`

---

## Color Scheme

### Light Mode

| Purpose | Color | Tailwind | Usage |
|---------|-------|----------|-------|
| Background | #FFFFFF | `bg-white` | Page background |
| Foreground | #000000 | `text-black` | Primary text |
| Sidebar | #F3F4F6 | `bg-gray-100` | Navigation panel |
| Border | #E5E7EB | `border-gray-200` | Dividers, edges |
| Accent | #3B82F6 | `bg-blue-500` | Links, active states |
| Hover | #DBEAFE | `hover:bg-blue-100` | Interactive states |
| Danger | #EF4444 | `bg-red-500` | Destructive actions |
| Success | #10B981 | `bg-green-500` | Positive feedback |

### Dark Mode

| Purpose | Color | Tailwind | Usage |
|---------|-------|----------|-------|
| Background | #0F172A | `dark:bg-slate-950` | Page background |
| Foreground | #F1F5F9 | `dark:text-slate-100` | Primary text |
| Sidebar | #1E293B | `dark:bg-slate-800` | Navigation panel |
| Border | #334155 | `dark:border-slate-700` | Dividers, edges |
| Accent | #3B82F6 | `dark:bg-blue-500` | Links, active states |
| Hover | #1E3A8A | `dark:hover:bg-blue-900` | Interactive states |
| Danger | #EF4444 | `dark:bg-red-600` | Destructive actions |
| Success | #10B981 | `dark:bg-green-600` | Positive feedback |

### Implementation

```tsx
// Auto-detected based on system preference
// Or manually controlled via SettingsStore

// Dark mode uses: <html class="dark">
// Tailwind applies dark: prefix styles

// Example component
<button className="bg-white dark:bg-slate-800 text-black dark:text-white">
  Click me
</button>
```

---

## Typography

### Font Stack

```css
/* tailwind.config.ts */
theme: {
  fontFamily: {
    sans: ['Inter', 'system-ui', 'sans-serif'],
    mono: ['JetBrains Mono', 'Monaco', 'Courier New', 'monospace'],
  }
}
```

### Type Scale

| Usage | Size | Line Height | Weight |
|-------|------|-------------|--------|
| H1 (Title) | 32px | 1.2 | 700 (bold) |
| H2 (Heading) | 24px | 1.3 | 600 (semibold) |
| H3 (Subheading) | 20px | 1.4 | 600 (semibold) |
| Body | 14px | 1.5 | 400 (regular) |
| Small | 12px | 1.4 | 400 (regular) |
| Code | 13px | 1.6 | 400 (monospace) |

### Example

```tsx
// Heading
<h1 className="text-2xl font-bold">PPM</h1>

// Body text
<p className="text-sm text-gray-600 dark:text-gray-400">
  Descriptive text
</p>

// Code/terminal text
<code className="font-mono text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
  npm install
</code>
```

---

## Component Patterns

### Button Component

```tsx
// Base button from shadcn/ui
import { Button } from "@/components/ui/button";

// Variants
<Button>Primary</Button>
<Button variant="outline">Outline</Button>
<Button variant="ghost">Ghost</Button>
<Button variant="destructive">Delete</Button>
<Button disabled>Disabled</Button>

// Sizes
<Button size="sm">Small</Button>
<Button size="default">Default</Button>
<Button size="lg">Large</Button>
```

### Input Component

```tsx
import { Input } from "@/components/ui/input";

<Input
  type="text"
  placeholder="Enter search..."
  className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
/>
```

### Dialog Component

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

<Dialog open={isOpen} onOpenChange={setIsOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Confirm Action</DialogTitle>
    </DialogHeader>
    <p>Are you sure?</p>
  </DialogContent>
</Dialog>
```

### Dropdown Menu

```tsx
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <Button variant="ghost" size="sm">•••</Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent>
    <DropdownMenuItem>Edit</DropdownMenuItem>
    <DropdownMenuItem>Delete</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

---

## Layout Structure

### Desktop Layout

```
┌─────────────────────────────────────────────────────────┐
│  Sidebar (300px)  │  MainArea                            │
├──────────────────┼─────────────────────────────────────┤
│ Project Selector │ ┌───────────────────────────────────┐│
├──────────────────┤ │  TabBar (Chat | Editor | Git | … )││
│ File Explorer    │ ├───────────────────────────────────┤│
│                  │ │  Tab Content (varies)             ││
│ • src/           │ │  CodeEditor, ChatTab, etc.        ││
│   - main.ts      │ │                                   ││
│   - utils.ts     │ │                                   ││
│                  │ │                                   ││
│ • dist/          │ │  (Fills remaining space)          ││
│                  │ │                                   ││
│                  │ │                                   ││
│                  │ └───────────────────────────────────┘│
└──────────────────┴─────────────────────────────────────┘
```

**Sidebar:** 300px fixed, scrollable, dark background
**MainArea:** Flex 1, contains TabBar + content
**TabBar:** Horizontal tabs (chat, editor, git, terminal, settings)
**Content:** Flex, fills remaining space, scrollable if needed

### Mobile Layout

```
┌─────────────────────────────────────┐
│ ☰ | Project Selector | ⚙️           │
├─────────────────────────────────────┤
│  MainArea (full width)              │
│                                     │
│  ChatTab / EditorTab / etc.         │
│                                     │
│  (Sidebar hidden, accessible via ☰) │
├─────────────────────────────────────┤
│  TabBar (bottom, horizontal scroll) │
│  [Chat] [Editor] [Git] [Terminal]   │
└─────────────────────────────────────┘
```

**Header:** Project selector + hamburger menu
**Content:** Full-width tab content
**TabBar:** Bottom navigation (mobile-friendly)
**Sidebar:** Slide-in drawer (MobileDrawer component)

### Responsive Breakpoints

```typescript
// tailwind.config.ts
screens: {
  sm: '640px',   // Mobile
  md: '768px',   // Tablet
  lg: '1024px',  // Desktop
  xl: '1280px',  // Wide desktop
  '2xl': '1536px' // Ultra-wide
}
```

**Rules:**
- `sm:` and below — Mobile optimizations
- `md:` and above — Show sidebar
- `lg:` and above — Full-width optimizations

---

## Component Library Usage

### File Tree Component

```tsx
// src/web/components/explorer/file-tree.tsx
// Shows directory structure with expand/collapse

<FileTree
  root={project.root}
  onSelect={(file) => openFile(file)}
  onContextMenu={(file) => showMenu(file)}
/>

// Features:
// - Lazy load directories (expand on click)
// - File icons based on extension
// - Highlight current file
// - Right-click context menu (create, delete, etc.)
```

### Code Editor

```tsx
// src/web/components/editor/code-editor.tsx
// Monaco Editor integration (@monaco-editor/react)

<CodeEditor
  language="javascript"
  value={fileContent}
  onChange={setFileContent}
  theme="dark"
  readOnly={false}
/>

// Features:
// - 50+ language support with IntelliSense
// - Real-time syntax highlighting
// - Line numbers, code folding
// - Find/replace (Ctrl+H)
// - Word wrap toggle (Alt+Z)
// - Monaco diff viewer for git diffs
// - Theme sync with app dark/light mode
// - VSCode-style breadcrumb navigation (EditorBreadcrumb)
// - File-type contextual toolbar (EditorToolbar)
```

### CSV Preview

```tsx
// src/web/components/editor/csv-preview.tsx
// Table viewer for CSV files with sorting and editing

<CsvPreview
  content={csvString}
  onContentChange={setCsvString}
/>

// Features:
// - State-machine CSV parser (handles quoted fields, embedded commas/newlines)
// - Virtual scrolling (@tanstack/react-virtual) for large files
// - Column sorting via @tanstack/react-table
// - Inline cell editing with live serialization
// - Mobile-friendly table layout
```

### Terminal Component

```tsx
// src/web/components/terminal/terminal-tab.tsx
// xterm.js integration

<TerminalTab projectName={project.name} />

// Features:
// - Full terminal emulation (bash/zsh)
// - 256 color support
// - Mouse support (click, scroll)
// - Resize handling
// - Copy/paste from clipboard
```

### Chat Component

```tsx
// src/web/components/chat/chat-tab.tsx
// Message list + input with file attachments

<ChatTab sessionId={sessionId} />

// Features:
// - Streaming message display
// - Tool use cards (file_read, git commands)
// - File attachment previews
// - Slash command autocomplete
// - Session switcher
```

### Git Status Panel

```tsx
// src/web/components/git/git-status-panel.tsx
// Git status with staging UI

<GitStatusPanel projectName={project.name} />

// Features:
// - Staged/unstaged/untracked file lists
// - Stage/unstage buttons
// - Commit message input
// - Commit graph (Mermaid)
```

---

## Dark Mode Implementation

### Automatic Detection

```tsx
// src/web/app.tsx
// Detect system preference

useEffect(() => {
  const preference = window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = preference.matches;
  setTheme(isDark ? 'dark' : 'light');
}, []);
```

### Manual Override

```tsx
// Settings tab allows user to choose:
// - System (follow OS preference)
// - Dark (always dark)
// - Light (always light)

// Implementation via next-themes
<ThemeProvider attribute="class" defaultTheme="system">
  <App />
</ThemeProvider>
```

### CSS in Dark Mode

```tsx
// Tailwind dark: prefix
<div className="bg-white dark:bg-slate-950 text-black dark:text-white">
  Content adapts to theme
</div>
```

---

## Responsive Design

### Mobile-First CSS

Start with mobile styles, add complexity for larger screens:

```css
/* Mobile-first */
.sidebar {
  display: none;  /* Hidden on mobile */
}

/* Tablet and up */
@media (min-width: 768px) {
  .sidebar {
    display: block;
    width: 300px;
  }
}
```

**Or in Tailwind:**
```tsx
<div className="hidden md:block w-64">
  Sidebar (hidden on mobile, shown on md+)
</div>
```

### Touch-Friendly Sizes

- **Button height:** 44px minimum (iOS guideline)
- **Touch target:** 44×44px or larger
- **Spacing:** 16px minimum between interactive elements

```tsx
// Good: Touch-friendly
<button className="px-4 py-3 rounded-lg">Click</button>

// Avoid: Too small
<button className="px-2 py-1">Click</button>
```

### Viewport Configuration

```html
<!-- public/index.html -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
```

---

## PWA Considerations

### Web App Manifest

```json
{
  "name": "Personal Project Manager",
  "short_name": "PPM",
  "description": "Mobile-first web IDE for managing code projects",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "theme_color": "#0F172A",
  "background_color": "#FFFFFF",
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    }
  ]
}
```

### Service Worker

- Cache static assets (CSS, JS, images)
- Offline fallback (HTML, basic UI)
- Background sync (planned for v3)

### Installation Prompt

- Browser shows "Add to Home Screen" on first visit
- Users can install as standalone app
- App opens fullscreen without browser chrome

---

## Animation & Micro-interactions

### Smooth Transitions

```css
/* Fade in content */
.fade-in {
  animation: fadeIn 0.3s ease-in;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

### Button Hover States

```tsx
<button className="bg-blue-500 hover:bg-blue-600 active:bg-blue-700 transition-colors">
  Click me
</button>
```

### Loading Spinner

```tsx
<Spinner className="animate-spin w-5 h-5" />
```

### Toast Notifications

```tsx
// sonner library for notifications
import { toast } from "sonner";

toast.success("File saved!");
toast.error("Failed to commit");
toast.loading("Pushing...");
```

---

## Accessibility

### Keyboard Navigation

- **Tab order:** Logical flow (left-to-right, top-to-bottom)
- **Focus visible:** Clear focus indicator on interactive elements
- **Keyboard shortcuts:** Alt+S (save), Ctrl+K (command palette), etc.

```tsx
// Good: Focus visible
<button className="focus-visible:ring-2 focus-visible:ring-blue-500">
  Click me
</button>
```

### Color Contrast

- **WCAG AA:** 4.5:1 for normal text, 3:1 for large text
- **Avoid:** Color-only indicators (use icons + text)

```tsx
// Good: Icon + text + color
<span className="text-red-600">
  <ErrorIcon className="inline" /> Error occurred
</span>

// Avoid: Color only
<span className="text-red-600">Error</span>
```

### ARIA Labels

```tsx
// Good: Descriptive labels
<button aria-label="Delete file">
  <TrashIcon />
</button>

<input
  type="text"
  aria-label="Search projects"
  placeholder="Search..."
/>
```

### Semantic HTML

```tsx
// Good: Semantic structure
<nav>Navigation here</nav>
<main>Main content</main>
<aside>Sidebar</aside>
<footer>Footer</footer>

// Avoid: Generic divs
<div>Navigation here</div>
<div>Main content</div>
```

---

## Visual Hierarchy

### Size & Weight

Larger, bolder elements draw attention first:

```tsx
// Page title (largest, boldest)
<h1 className="text-3xl font-bold">Project Name</h1>

// Section heading (medium)
<h2 className="text-xl font-semibold">Files</h2>

// Regular text (small, normal weight)
<p className="text-sm font-normal">3 files</p>
```

### Spacing & Whitespace

- **Compact:** 8px gutters between elements
- **Normal:** 16px padding inside containers
- **Generous:** 24px+ between major sections

```tsx
// Compact list
<ul className="space-y-1">
  <li>Item 1</li>
  <li>Item 2</li>
</ul>

// Generous spacing
<section className="mb-8">
  <h2 className="mb-4">Title</h2>
  <p className="mb-4">Paragraph 1</p>
  <p>Paragraph 2</p>
</section>
```

---

## Icon Guidelines

**Lucide Icons** — Consistent 24px icons for UI

### Usage Patterns

- **Navigation:** Folder, File, Terminal, Settings icons
- **Actions:** Plus (add), Trash (delete), Check (confirm)
- **Status:** CheckCircle (success), XCircle (error), AlertCircle (warning)
- **Modifiers:** ChevronRight (expand), X (close)

```tsx
import { FileIcon, FolderIcon, TrashIcon } from "lucide-react";

<FileIcon className="w-5 h-5 text-gray-600" />
```

### Size Guidelines

- **UI elements:** 16px–20px (inline, labels)
- **Buttons:** 20px–24px (primary actions)
- **Headers:** 32px+ (large, prominent)

