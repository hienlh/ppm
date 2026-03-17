# Nghiên cứu Kiến trúc React Web Editor

**Ngày:** 2026-03-17
**Người nghiên cứu:** Claude (Haiku)
**Trọng tâm:** Các mô hình phổ biến của web IDE/editor (VS Code Web, CodeSandbox, StackBlitz, Monaco-based IDEs)

---

## Tóm tắt

Các React web editor hiện đại hội tụ về ~5 mô hình kiến trúc cốt lõi: hệ thống layout có thể resize, quản lý tab lazy-load, thư viện wrapper cho editor (Monaco hoặc CodeMirror), quản lý state nguyên tử, và abstraction hệ thống file ảo. Không có "chuẩn" duy nhất — cách triển khai khác nhau tuỳ độ trưởng thành của sản phẩm và yêu cầu hiệu năng.

---

## 1. Kiến trúc Layout

### Hệ thống Panel có thể Resize
**Thư viện chính:** `react-resizable-panels` (tác giả Brian Vaughn)
- Mô hình layout theo dạng lồng nhau: `PanelGroup` → `Panel` + `PanelResizer`
- Hỗ trợ chia ngang/dọc, giới hạn min/max, snapping, lưu trạng thái
- Hỗ trợ bàn phím (phím mũi tên, phím tắt thu gọn)
- Có thể lồng nhau tùy ý cho layout IDE phức tạp (sidebar + editor + preview + terminal)

**Cách tiếp cận của Sandpack (CodeSandbox):**
- Component preset bao gồm sẵn các cột/hàng có thể resize
- Người dùng có thể mở rộng/thu hẹp mà không cần thay đổi code
- Được thiết kế cho việc tạo prototype nhanh

### Cấu trúc State
```
layout = {
  panels: {
    sidebar: { width: 250, collapsed: false },
    editor: { width: 600 },
    preview: { width: 400 },
  },
  splits: [
    { direction: 'horizontal', ratio: 0.3 },
    { direction: 'vertical', ratio: 0.6 }
  ]
}
```

### Pattern Responsive
- **Mobile-first:** Ẩn/thu gọn panel trên màn hình nhỏ, xếp dọc
- **Persistence:** Lưu kích thước layout vào localStorage hoặc server
- **Context-aware:** Layout khác nhau cho từng loại workspace

---

## 2. Quản lý Tab

### Thực hành tốt nhất hiện tại
**Pattern Keep-Alive:**
- Render NỘI DUNG của TẤT CẢ tab đang mở (không unmount), ẩn bằng `display: none`
- Tránh mất state khi chuyển tab, giữ vị trí scroll của editor
- Đánh đổi: DOM phình to nhưng UX mượt mà hơn

**Lazy Loading:**
- Tải nội dung tab lần đầu tiên xem
- Giải phóng khi tab đóng
- Dưới 20 tab: keep-alive thắng; từ 50+ tab: cần lazy-loading

**Tối ưu hiệu năng:**
1. **Tab Index/Metadata:** Lưu trong store nhẹ (Zustand/Jotai)
   ```
   { id, name, isDirty, language, unsavedHash }
   ```
2. **Content Reference:** Lưu theo file ID, render qua ref thay vì prop
3. **Memoization:** Bọc từng tab component bằng `React.memo()`
4. **Virtualization:** Nếu 100+ tab, dùng react-window (hiếm trong thực tế)

### Ví dụ tổ chức State
```javascript
// Danh sách tab (nhẹ)
const tabs = [
  { id: 'file-1', name: 'main.ts', isDirty: false },
  { id: 'file-2', name: 'config.yaml', isDirty: true },
]

// Nội dung tab (lưu riêng, key theo file ID)
const tabContent = {
  'file-1': <EditorPanel fileId="file-1" /> // render nhưng ẩn nếu không active
  'file-2': <EditorPanel fileId="file-2" />
}
```

---

## 3. Tích hợp Code Editor

### Monaco Editor (Phổ biến nhất)

**Wrapper:** `@monaco-editor/react`
- Tích hợp một dòng, không cần cấu hình webpack
- Tự động xử lý việc load Monaco từ CDN hoặc bundle
- Hoạt động với Vite, Next.js, create-react-app

**Pattern tích hợp:**
```typescript
import Editor from '@monaco-editor/react';

export const CodeEditor = ({ value, onChange, language }) => (
  <Editor
    height="100%"
    language={language}
    value={value}
    onChange={onChange}
    options={{
      minimap: { enabled: false },
      wordBasedSuggestions: 'currentDocument', // tránh gợi ý chéo giữa các editor
    }}
  />
);
```

**Quản lý State:**
- Dùng **ref + useCallback** cho hiệu năng (không re-render editor khi code thay đổi)
- Lưu toàn bộ nội dung trong parent store (Zustand/Jotai)
- Lắng nghe `editor.onDidChangeModelContent()` để cập nhật

### CodeMirror 6 (Lựa chọn nhẹ hơn)

**Ưu điểm chính:** Bundle nhỏ hơn (~80KB vs Monaco ~5MB), module hóa cao hơn

**Tích hợp:**
```typescript
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';

const state = EditorState.create({
  doc: code,
  extensions: [
    javascript(),
    autocompletion(),
  ]
});

const view = new EditorView({ state, parent: container });
```

**Thiết lập Autocomplete:**
- Dùng `@codemirror/autocomplete` + custom completion source
- Context object cung cấp `tokenBefore()` cho gợi ý thông minh
- Tích hợp LSP nhẹ hơn Monaco

### Tích hợp LSP/Autocomplete

**Cách tiếp cận tốt nhất:**
1. Chạy language server ở background (Node.js, Python, v.v.)
2. Kết nối qua **WebSocket + vscode-jsonrpc** (giao thức JSON-RPC 2.0)
3. Bind vào completion provider của editor
4. Theo dõi thay đổi file → gửi thông báo didChange đến LSP

**Thư viện chính:** `monaco-languageclient` (TypeFox)
- Bọc Monaco + giao tiếp LSP
- Tự động xử lý chi tiết giao thức
- Dùng trong Eclipse Theia, VS Code Web

**Lưu ý quan trọng:**
- Monaco đi kèm sẵn autocomplete cho TS/JS (không cần LSP)
- Với ngôn ngữ tùy chỉnh: đảm bảo phiên bản LSP khớp với monaco-languageclient
- Chú ý version matrix: Monaco → monaco-languageclient → Language Server (phải đồng bộ)

---

## 4. Quản lý State

### Zustand (Phổ biến nhất cho Editor)

**Ưu điểm:**
- Store tập trung duy nhất (mental model đơn giản)
- Cập nhật immutable, tối ưu render thủ công qua selector
- Bundle nhỏ (~2KB), ít boilerplate
- Được dùng bởi: Excalidraw, một số pattern nội bộ của CodeSandbox

**Pattern cho File Editor:**
```typescript
create((set) => ({
  files: { 'file-1': { name: 'main.ts', content: '' } },
  tabs: [ 'file-1', 'file-2' ],
  activeTab: 'file-1',
  updateFile: (id, content) => set(state => ({
    files: { ...state.files, [id]: { ...state.files[id], content } }
  })),
  setActiveTab: (id) => set({ activeTab: id }),
}))
```

### Jotai (Lựa chọn Atomic)

**Ưu điểm:**
- Reactivity chi tiết (atom chỉ trigger re-render tối thiểu)
- Hoạt động tốt với async (async atom để fetch)
- Scale tốt hơn Zustand khi có 50+ state liên quan

**Pattern:**
```typescript
const fileAtom = atom({ id: 'file-1', content: '' });
const activeTabAtom = atom('file-1');
const isDirtyAtom = atom((get) =>
  get(fileAtom).content !== lastSaved // computed atom
);
```

**Khi nào chọn:**
- **Zustand:** Dưới 20 file, state sync đơn giản
- **Jotai:** 50+ file, state derived phức tạp, async operations

### Triển khai Undo/Redo

**Cách 1: Immer + History Stack**
```typescript
const store = create((set) => ({
  past: [],
  present: { files: {} },
  future: [],
  updateFile: (id, content) => set((state) => ({
    past: [...state.past, state.present],
    present: immer.produce(state.present, draft => { draft.files[id] = content; }),
    future: [],
  })),
  undo: () => set(state => ({
    past: state.past.slice(0, -1),
    present: state.past[state.past.length - 1],
    future: [state.present, ...state.future],
  })),
}))
```

**Cách 2: Version Vector (kiểu VSCode)**
- Mỗi file có bộ đếm edit ID
- Khi undo, quay về snapshot ID trước
- Tốt hơn cho collaborative editing (thân thiện với CRDT)

---

## 5. Pattern Hiệu năng

### Chiến lược Memoization
- **Components:** Bọc tab components, editor panels bằng `React.memo()`
- **Selectors:** Zustand selectors cho partial state (tránh re-render toàn bộ store)
- **Callbacks:** `useCallback()` cho editor onChange, tab click handlers

### Lazy Loading
```typescript
const EditorPanel = React.lazy(() => import('./EditorPanel'));

<Suspense fallback={<Loading />}>
  <EditorPanel fileId={activeTab} />
</Suspense>
```

### Virtual Scrolling (cây file, 1000+ item)
- Dùng `react-window` hoặc `react-virtualized`
- Chỉ render 20-30 item đang hiển thị, cuộn ảo phần còn lại

### Tối ưu Bundle Size
- **Monaco:** Lazy load toàn bộ editor khi dùng lần đầu (không load khi tải trang)
- **CodeMirror:** Mặc định tốt hơn (bundle nhỏ hơn), load theo yêu cầu
- **Language extensions:** Code-split theo từng ngôn ngữ (JSON, Python, Go, v.v.)

---

## 6. Abstraction Hệ thống File

### Browser File System API (Hiện đại)
```typescript
// Người dùng chọn thư mục qua dialog native
const dirHandle = await showDirectoryPicker();

// Liệt kê nội dung
for await (const [name, handle] of dirHandle) {
  if (handle.kind === 'file') {
    const file = await handle.getFile();
    const content = await file.text();
    // lưu vào state
  }
}

// Ghi lại thay đổi
const fileHandle = await dirHandle.getFileHandle('main.ts', { create: true });
const writable = await fileHandle.createWritable();
await writable.write(newContent);
await writable.close();
```

**Hỗ trợ:** Chrome/Edge 86+, Safari 15.1+, Firefox 111+ (mới thêm)

### Virtual File System (Fallback đa nền tảng)

**Thư viện BrowserFS:**
- Giả lập Node.js fs API trong browser
- Nhiều backend: IndexedDB, LocalStorage, bộ nhớ
- **MountableFileSystem:** Kết hợp nhiều backend thành một cây duy nhất
- **OverlayFS:** Mount read-only FS thành read-write (hữu ích cho template)

```typescript
const fs = new BrowserFS.FileSystem.MountableFileSystem();
fs.mount('/home', new BrowserFS.FileSystem.IndexedDB());
fs.mount('/tmp', new BrowserFS.FileSystem.InMemory());

// Dùng như Node.js: fs.readFile(), fs.writeFile()
```

### Biểu diễn State
```typescript
type VirtualFS = {
  [path: string]: {
    type: 'file' | 'dir',
    content?: string,      // cho file
    modified?: number,     // timestamp
    isDirty?: boolean,     // thay đổi chưa lưu
  }
};
```

---

## 7. Khuyến nghị cho PPM

### Stack khuyến nghị
```
Layout:      react-resizable-panels
Tabs:        Custom (keep-alive pattern cho <50 tab)
Editor:      @monaco-editor/react (đầy đủ tính năng) HOẶC @codemirror/basic-setup (nhẹ)
State:       Zustand (file tree) + Zustand (UI layout) HOẶC single Zustand store
LSP:         monaco-languageclient (nếu cần) + WebSocket backend
File System: Browser File System API (chính) + fallback IndexedDB virtualization
```

### Sơ đồ kiến trúc
```
┌─────────────────────────────────────────────────────────────┐
│ PPM Editor                                                  │
├─────────────┬───────────────┬──────────────┬────────────────┤
│ File Tree   │   Tab Bar     │   Code       │   Preview/     │
│ (Sidebar)   │               │   Editor     │   Terminal     │
│             │               │              │                │
│ Zustand:    │ Zustand:      │ Monaco/CM6   │ React          │
│ - files     │ - activeTab   │ (wrapped)    │ Components     │
│ - expanded  │ - tabs[]      │              │                │
│             │ - dirty state │ State:       │ State:         │
│             │               │ - content    │ - output       │
│             │               │ - language   │ - visible      │
│             │               │              │                │
└─────────────┴───────────────┴──────────────┴────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │ Browser File System API        │
        │ (hoặc BrowserFS fallback)      │
        └────────────────────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │ Backend WebSocket              │
        │ (đồng bộ file, LSP, thực thi) │
        └────────────────────────────────┘
```

---

## Tổng kết các phát hiện chính

1. **Không có "chuẩn" duy nhất**: Mỗi nền tảng (VS Code Web, CodeSandbox, StackBlitz) dùng biến thể riêng
2. **react-resizable-panels là de facto standard** cho layout IDE
3. **Monaco chiếm ưu thế** cho editor đầy đủ tính năng; CodeMirror cho bản nhẹ
4. **Keep-alive tabs thắng** về độ mượt khi dưới 50 tab
5. **Zustand đang thắng** về độ đơn giản; Jotai cho khả năng scale
6. **File System API sẵn sàng** trên browser hiện đại; BrowserFS làm fallback universal
7. **Tích hợp LSP** cần căn chỉnh version cẩn thận (Monaco ↔ monaco-languageclient ↔ Language Server)

---

## Câu hỏi chưa giải quyết

1. **Chiến lược lưu tab:** Lưu bao nhiêu metadata tab vào server so với localStorage?
2. **Phạm vi Undo:** Theo từng file hay toàn cục? Ảnh hưởng đáng kể đến cấu trúc state.
3. **Mức độ cần LSP:** PPM có cần LSP đầy đủ hay chỉ cần syntax highlighting + snippets?
4. **Layout mobile:** Tab nên thu gọn/ẩn trên mobile, hay xếp dọc?
5. **Collaborative editing:** Nếu cần sau này, Zustand có tương thích tốt với thư viện CRDT không?

---

## Nguồn tham khảo

### Layout & Panels
- [react-resizable-panels by Brian Vaughn](https://github.com/bvaughn/react-resizable-panels)
- [react-resizable-panels demo](https://react-resizable-panels.vercel.app/)
- [Sandpack layout documentation](https://sandpack.codesandbox.io/docs/getting-started/layout)

### Monaco Editor
- [@monaco-editor/react npm](https://www.npmjs.com/package/@monaco-editor/react)
- [LSP integration guide](https://github.com/Barahlush/monaco-lsp-guide)
- [TypeFox monaco-languageclient](https://github.com/TypeFox/monaco-languageclient)
- [Medium: Integrating LSP with Monaco](https://medium.com/@zsh-eng/integrating-lsp-with-the-monaco-code-editor-b054e9b5421f)

### CodeMirror 6
- [CodeMirror React Integration](https://www.codiga.io/blog/implement-codemirror-6-in-react/)
- [@codemirror/autocomplete package](https://www.npmjs.com/package/@codemirror/autocomplete)
- [CodeMirror Autocompletion Examples](https://codemirror.net/examples/autocompletion/)

### State Management
- [Zustand vs Jotai comparison (2025)](https://dev.to/hijazi313/state-management-in-2025-when-to-use-context-redux-zustand-or-jotai-2d2k)
- [Jotai documentation](https://jotai.org/docs/basics/comparison)

### File System APIs
- [File System Access API (Chrome Developers)](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- [MDN File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)
- [BrowserFS GitHub](https://github.com/jvilk/BrowserFS)
- [browser-fs-access (powers Excalidraw)](https://github.com/GoogleChromeLabs/browser-fs-access)
