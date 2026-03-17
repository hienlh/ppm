# Phase 09: Monaco Editor Migration

## Overview
- **Priority:** High (independent — can run in parallel with phases 1-8)
- **Status:** complete

Replace CodeMirror 6 with Monaco Editor in both `code-editor.tsx` and `diff-viewer.tsx`. Monaco provides VS Code-identical UX: same keybindings, intellisense, themes, minimap, and diff rendering.

## Context Links
- Code editor: `src/web/components/editor/code-editor.tsx`
- Diff viewer: `src/web/components/editor/diff-viewer.tsx`
- Vite config: `vite.config.ts`
- Package: `package.json`

## Current vs Target

| | CodeMirror (current) | Monaco (target) |
|--|--|--|
| Editor | `@uiw/react-codemirror` | `@monaco-editor/react` |
| Diff | `@codemirror/merge` MergeView | `@monaco-editor/react` DiffEditor |
| Theme | `@codemirror/theme-one-dark` | `vs-dark` built-in |
| Language | `@codemirror/lang-*` extensions | Language ID string |
| Word wrap | `EditorView.lineWrapping` | `wordWrap: 'on'` option |
| Alt+Z | domEventHandlers hack | `editor.addCommand(...)` |
| Bundle | ~400KB | ~5MB → **must lazy load** |
| Autocomplete | `@codemirror/autocomplete` | Built-in IntelliSense |
| Scroll sync diff | Manual addEventListener | Built-in |

## Packages

### Add
```
@monaco-editor/react   # React wrapper (lazy loads Monaco)
vite-plugin-monaco-editor  # Vite worker config (local bundle, no CDN)
```

### Remove (all `@codemirror/*` + `codemirror`)
```
@codemirror/autocomplete
@codemirror/lang-css
@codemirror/lang-html
@codemirror/lang-javascript
@codemirror/lang-json
@codemirror/lang-markdown
@codemirror/lang-python
@codemirror/merge
@codemirror/state
@codemirror/theme-one-dark
@codemirror/view
@uiw/react-codemirror
codemirror
```

> **Check first:** grep for any other files importing `@codemirror/*` before removing

## Architecture

### Vite Config (workers)
```typescript
// vite.config.ts — add plugin
import monacoEditorPlugin from 'vite-plugin-monaco-editor'

plugins: [
  react(),
  monacoEditorPlugin({ languages: ['javascript', 'typescript', 'python', 'html', 'css', 'json', 'markdown', 'yaml', 'shell'] }),
]
```

This bundles Monaco workers locally — no CDN dependency.

### Language ID mapping
```typescript
// Replace getLanguageExtension() returning CodeMirror Extension
function getMonacoLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', html: 'html',
    css: 'css', scss: 'scss',
    json: 'json', md: 'markdown', mdx: 'markdown',
    yaml: 'yaml', yml: 'yaml',
    sh: 'shell', bash: 'shell',
  }
  return map[ext] ?? 'plaintext'
}
```

### code-editor.tsx rewrite (editor section)
```tsx
import Editor, { type OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'

// Replace <CodeMirror> block:
const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)

const handleEditorMount: OnMount = (editor) => {
  editorRef.current = editor
  // Alt+Z → word wrap toggle
  editor.addCommand(
    monaco.KeyMod.Alt | monaco.KeyCode.KeyZ,
    () => toggleWordWrap()
  )
}

<Editor
  height="100%"
  language={getMonacoLanguage(filePath)}
  value={content ?? ''}
  onChange={(val) => handleChange(val ?? '')}
  onMount={handleEditorMount}
  theme="vs-dark"
  options={{
    fontSize: 13,
    fontFamily: 'var(--font-mono)',
    wordWrap: wordWrap ? 'on' : 'off',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
  }}
  loading={<Loader2 className="size-5 animate-spin" />}
/>
```

### diff-viewer.tsx rewrite (diff section)
```tsx
import { DiffEditor } from '@monaco-editor/react'

// Replace entire MergeView useEffect + containerRef with:
<DiffEditor
  height="100%"
  language={getMonacoLanguage(filePath ?? '')}
  original={original}
  modified={modified}
  theme="vs-dark"
  options={{
    fontSize: 13,
    fontFamily: 'var(--font-mono)',
    wordWrap: wordWrap ? 'on' : 'off',
    renderSideBySide: expandMode !== 'left' && expandMode !== 'right',
    readOnly: true,
    automaticLayout: true,
    scrollBeyondLastLine: false,
  }}
/>
```

**DiffEditor expand mode:**
- `expandMode === 'both'` → `renderSideBySide: true`
- `expandMode === 'left'` OR `'right'` → `renderSideBySide: false` (inline diff)
  - Note: Monaco DiffEditor doesn't support showing only one side; "single panel" → use inline diff mode

**Things to keep (no change needed):**
- All file loading / saving logic
- Markdown preview (`<MarkdownPreview />`)
- Image preview (`<ImagePreview />`)
- PDF preview (`<PdfPreview />`)
- Tab dirty indicator logic
- Auto-save debounce logic

## Related Code Files
- Modify: `src/web/components/editor/code-editor.tsx`
- Modify: `src/web/components/editor/diff-viewer.tsx`
- Modify: `vite.config.ts` — add monaco worker plugin
- Modify: `package.json` — add/remove deps

## Implementation Steps

1. `bun add @monaco-editor/react vite-plugin-monaco-editor`
2. Configure `vite.config.ts` with monaco worker plugin
3. Rewrite `code-editor.tsx` editor section:
   - Replace `getLanguageExtension()` with `getMonacoLanguage()`
   - Replace `<CodeMirror>` with `<Editor>` (Monaco)
   - Wire `onMount` for Alt+Z keybinding
   - Remove CodeMirror-specific imports
4. Rewrite `diff-viewer.tsx`:
   - Replace MergeView + all imperative DOM code with `<DiffEditor>`
   - Map `expandMode` to Monaco options
   - Remove CodeMirror scroll sync logic (built-in)
   - Remove all `useRef<MergeView>` + destroy logic
5. Remove unused packages: `bun remove @uiw/react-codemirror @codemirror/lang-css @codemirror/lang-html @codemirror/lang-javascript @codemirror/lang-json @codemirror/lang-markdown @codemirror/lang-python @codemirror/merge @codemirror/state @codemirror/theme-one-dark @codemirror/view @codemirror/autocomplete codemirror`
6. Verify build: `bun run build` — no errors
7. Smoke test: open editor tab, diff tab, verify syntax highlight, word wrap, Alt+Z, save

## Todo

- [ ] Install `@monaco-editor/react` + `vite-plugin-monaco-editor`
- [ ] Configure vite.config.ts
- [ ] Rewrite code-editor.tsx (editor section only)
- [ ] Rewrite diff-viewer.tsx
- [ ] Remove old `@codemirror/*` packages
- [ ] Build check
- [ ] Smoke test

## Success Criteria
- Editor loads with VS Code-like UX (syntax highlight, IntelliSense, line numbers)
- Diff viewer shows side-by-side diffs with change highlights
- Word wrap (Alt+Z) works
- Auto-save still functions
- No CodeMirror imports remain
- Build succeeds

## Risk Assessment
- **Monaco bundle size (~5MB)**: `vite-plugin-monaco-editor` code-splits workers so initial load is not blocked. Editor itself lazy-loads on first render.
- **`expandMode` left/right**: Monaco DiffEditor has no "show only original" mode. `renderSideBySide: false` shows inline diff (both sides in one column). If user wants true left/right expand, need custom CSS hack hiding one panel — acceptable to simplify: left/right both → `renderSideBySide: false`.
- **`var(--font-mono)` in Monaco**: Monaco resolves CSS vars at load time. May need to pass resolved font family string. Fallback: `'Menlo, Monaco, Consolas, monospace'`.
- **Bun + vite-plugin-monaco-editor compatibility**: Widely used with Vite 5+; should work fine with Bun as runtime.
