/**
 * Vendor the Fluent System Icons the app's chrome uses into one module.
 *
 * The set is the one `miguelsolorio.fluent-icons` puts over VS Code's product
 * icons, taken from the Iconify collection generated out of Microsoft's
 * `fluentui-system-icons`. **20px Regular** throughout: that is the size the
 * glyphs were drawn at, and the size VS Code's own chrome uses them at.
 *
 * Unlike the file icons, these are monochrome and inherit `currentColor`, so
 * they are real inline `<svg>` elements — the whole app colours its icons with
 * `text-*` classes, and a `background-image` cannot inherit anything.
 *
 * `MAP` is the interesting part. Only 72 of the 222 names the app imports from
 * `lucide-react` kebab-case straight onto a Fluent name, because the two sets
 * name things differently: lucide's `X` is Fluent's `dismiss`, `Check` is
 * `checkmark`, `Trash2` is `delete`, `Plus` is `add`, `RefreshCw` is
 * `arrow-sync`. The rest are listed by hand, and a `null` means Fluent has no
 * equivalent worth the swap — a brand mark, or a glyph VS Code's own icon font
 * has and Fluent does not (`git-commit`). Those stay on lucide, so nothing
 * regresses into a wrong-looking icon for the sake of consistency.
 *
 *   bun scripts/gen-product-icons.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(import.meta.dir, "../src/web/lib/icons.generated.tsx");

/**
 * `null` = keep lucide's glyph. Anything else is a Fluent name *without* the
 * `-20-regular` suffix; the script adds it and fails loudly on a name the
 * collection does not have.
 */
const MAP: Record<string, string | null> = {
  // --- Navigation and disclosure
  ChevronDown: "chevron-down",
  ChevronDownIcon: "chevron-down",
  ChevronLeft: "chevron-left",
  ChevronRight: "chevron-right",
  ChevronRightIcon: "chevron-right",
  ChevronUp: "chevron-up",
  ChevronUpIcon: "chevron-up",
  ChevronsDown: "chevron-double-down",
  ChevronsDownUp: "chevron-down-up", // the *collapse* pair; `chevron-up-down` is expand
  ChevronsRight: "chevron-double-right",
  ChevronsUpDown: "chevron-up-down",
  ArrowDown: "arrow-down",
  ArrowLeft: "arrow-left",
  ArrowRight: "arrow-right",
  ArrowUp: "arrow-up",
  ArrowUpCircle: "arrow-circle-up",
  ArrowDownToLine: "arrow-download",
  ArrowUpFromLine: "arrow-upload",
  ArrowDownUp: "arrow-sort",
  ArrowUpDown: "arrow-sort",
  ArrowDownAZ: "text-sort-ascending",
  Menu: "navigation",
  MoreHorizontal: "more-horizontal",
  MoreVertical: "more-vertical",
  ExternalLink: "open",

  // --- The verbs. Every one of these is a different word in Fluent.
  X: "dismiss",
  XIcon: "dismiss",
  XCircle: "dismiss-circle",
  CircleX: "dismiss-circle",
  OctagonXIcon: "dismiss-circle",
  XSquare: "square-dismiss",
  Check: "checkmark",
  CheckIcon: "checkmark",
  CheckCircle: "checkmark-circle",
  CheckCircle2: "checkmark-circle",
  CircleCheckIcon: "checkmark-circle",
  Plus: "add",
  Minus: "subtract",
  Trash2: "delete",
  Copy: "copy",
  Pencil: "edit",
  PencilLine: "edit",
  Search: "search",
  Filter: "filter",
  ListFilter: "filter",
  Download: "arrow-download",
  Upload: "arrow-upload",
  RefreshCw: "arrow-sync",
  RotateCw: "arrow-clockwise",
  RotateCcw: "arrow-counterclockwise",
  Undo2: "arrow-undo",
  Redo2: "arrow-redo",
  Save: "save",
  Send: "send",
  Scissors: "cut",
  Share2: "share",
  Play: "play",
  Pause: "pause",
  Loader2: "spinner-ios",
  Loader2Icon: "spinner-ios",

  // --- Status
  AlertCircle: "error-circle",
  AlertTriangle: "warning",
  TriangleAlert: "warning",
  TriangleAlertIcon: "warning",
  Info: "info",
  InfoIcon: "info",
  CircleHelp: "question-circle",
  HelpCircle: "question-circle",
  Circle: "circle",
  CircleIcon: "circle",
  Square: "square",
  Activity: "pulse",
  Gauge: "gauge",
  Clock: "clock",
  History: "history",
  CalendarClock: "calendar-clock",
  CalendarX2: "calendar-cancel",

  // --- Files and folders (the *chrome* ones; real file icons are elsewhere)
  File: "document",
  FileText: "document-text",
  ScrollText: "document-text",
  FileCode: "code",
  FilePen: "document-edit",
  FilePlus: "document-add",
  FilePlus2: "document-add",
  FileSearch: "document-search",
  FileWarning: "document-error",
  FileType: "text-font",
  FileJson: null, // `document-javascript` is the wrong language, not a generic one
  FileDiff: null, // Fluent has no diff glyph; VS Code's own icon font does
  Folder: "folder",
  FolderOpen: "folder-open",
  FolderPlus: "folder-add",
  FolderSearch: "folder-search",
  FolderSymlink: "folder-link",
  FolderTree: "text-bullet-list-tree",
  FolderGit2: null, // git-specific, and `folder-link` would read as a symlink
  Clipboard: "clipboard",
  ClipboardCheck: "clipboard-checkmark",
  ClipboardList: "clipboard-task",
  ClipboardPaste: "clipboard-paste",
  List: "text-bullet-list-ltr",
  ListChecks: "task-list-square-ltr",
  ListTodo: "task-list-square-ltr",
  ListOrdered: "text-number-list-ltr",
  Table: "table",
  Tag: "tag",
  Tags: "tag-multiple",
  Paperclip: "attach",
  Link: "link",
  Link2: "link",
  Link2Off: "link-dismiss",
  Unlink: "link-dismiss",

  // --- Panels, windows, layout
  PanelBottom: "panel-bottom",
  PanelLeft: "panel-left",
  PanelLeftOpen: "panel-left-expand",
  PanelRight: "panel-right",
  Columns: "layout-column-two",
  Columns2: "layout-column-two",
  Columns3: "layout-column-three",
  Grid2x2: "grid",
  LayoutGrid: "grid",
  Layers: "layer",
  AppWindow: "window",
  PictureInPicture2: "picture-in-picture",
  Maximize: "full-screen-maximize",
  Maximize2: "arrow-maximize",
  Minimize: "full-screen-minimize",
  Minimize2: "arrow-minimize",
  GripHorizontal: "re-order-dots-horizontal",
  GripVertical: "re-order-dots-vertical",
  ZoomIn: "zoom-in",
  ZoomOut: "zoom-out",
  Scan: null, // `scan-camera` and friends are all about cameras
  Crosshair: "target",
  MousePointer2: "cursor",
  SquareDashedMousePointer: "select-object",
  TextSelect: "select-all-on",
  Hand: "hand-left",

  // --- Development
  Terminal: "window-console",
  TerminalSquare: "window-console",
  SquareTerminal: "window-console",
  Code: "code",
  Bug: "bug",
  GitBranch: "branch",
  GitCommitHorizontal: null, // no commit glyph in Fluent
  Database: "database",
  DatabaseZap: "database-lightning",
  Puzzle: "puzzle-piece",
  FlaskConical: "beaker",
  Network: null, // the file browser's Network *location*; `network-check` is a signal meter
  Plug: "plug-connected",
  Keyboard: "keyboard",
  Settings: "settings",
  Settings2: "settings-cog-multiple",
  Palette: "color",
  Sparkles: "sparkle",
  Bot: "bot",
  BotMessageSquare: "bot",
  Brain: "brain-circuit",
  Lightbulb: "lightbulb",
  MessageSquare: "chat",
  // The empty bubble, for the tab's streaming indicator. `chat` already draws
  // two message lines inside itself, so the typing dots landed on top of them
  // and welded into one smudge at 16px — the bounce had nothing legible to move.
  MessageCircle: "chat-empty",
  QrCode: "qr-code",
  Hexagon: null, // a shape, not a concept — lucide's is the right weight
  Slash: null,
  Github: null, // brand mark

  // --- The search widget's modifier toggles. VS Code draws these itself and
  // Fluent has nothing that reads as "match case" or "use regular expression";
  // a wrong glyph on a toggle is worse than an inconsistent one.
  CaseSensitive: null,
  WholeWord: null,
  Regex: null,
  ReplaceAll: null,

  // --- Devices, system, network
  Monitor: "desktop",
  MonitorX: "desktop-off",
  MonitorSmartphone: "phone-desktop",
  Smartphone: "phone",
  HardDrive: "hard-drive",
  Cpu: "developer-board",
  Usb: "usb-stick",
  Power: "power",
  PowerOff: null, // Fluent ships no off variant
  Wifi: "wifi-1",
  WifiOff: "wifi-off",
  Cloud: "cloud",
  CloudOff: "cloud-off",
  Globe: "globe",
  ServerOff: null, // `server` exists, its off variant does not
  Home: "home",
  Mic: "mic",
  MicOff: "mic-off",
  Volume1: "speaker-1",
  Volume2: "speaker-2",
  VolumeX: "speaker-off",
  Image: "image",
  ImageOff: "image-off",
  ImagePlus: "image-add",
  Music: "music-note-2",
  Coffee: "drink-coffee",
  Heart: "heart",
  Sun: "weather-sunny",
  Moon: "weather-moon",
  Zap: "flash",
  ZapOff: "flash-off",
  WrapText: "text-wrap",
  FlipHorizontal: "flip-horizontal",
  FlipHorizontal2: "flip-horizontal",
  FlipVertical: "flip-vertical",
  FlipVertical2: "flip-vertical",

  // --- People, security, notifications
  Users: "people",
  UserRound: "person",
  UserPlus: "person-add",
  Bell: "alert",
  BellOff: "alert-off",
  BellRing: "alert-urgent",
  Lock: "lock-closed",
  Key: "key",
  KeyRound: "key",
  ShieldAlert: "shield-error",
  ShieldCheck: "shield-checkmark",
  ShieldOff: "shield-dismiss",
  LogIn: "arrow-enter",
  LogOut: "sign-out",
  Eye: "eye",
  EyeOff: "eye-off",
  Pin: "pin",
  PinOff: "pin-off",
};

const collection = (
  await import("@iconify-json/fluent/icons.json", { with: { type: "json" } })
).default as {
  icons: Record<string, { body: string }>;
  width?: number;
  height?: number;
};

/**
 * Pull the `d` of every path out of a body.
 *
 * 2819 of the 2873 20px Regular glyphs are nothing but
 * `<path fill="currentColor" d="…"/>` repeated, which is what lets these render
 * as ordinary JSX instead of `dangerouslySetInnerHTML`. A glyph that is not —
 * one wrapped in a `<g>`, or carrying a `fill-rule` — returns null and is
 * reported, so the name falls back to lucide rather than rendering a fragment
 * of itself.
 */
function pathData(body: string): string[] | null {
  const paths: string[] = [];
  const re = /<path\s+fill="currentColor"\s+d="([^"]*)"\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) paths.push(m[1]!);
  if (paths.length === 0) return null;
  return body.replace(re, "").trim() === "" ? paths : null;
}

const missing: string[] = [];
const notPaths: string[] = [];
/** Fluent name → its paths, shared by every lucide name that maps to it. */
const glyphs = new Map<string, string[]>();
/** lucide export name → Fluent name, for the ones that resolved. */
const resolved: Record<string, string> = {};
const kept: string[] = [];

for (const [lucideName, fluentName] of Object.entries(MAP)) {
  if (fluentName === null) {
    kept.push(lucideName);
    continue;
  }
  const key = `${fluentName}-20-regular`;
  if (!glyphs.has(fluentName)) {
    const icon = collection.icons[key];
    if (!icon) {
      missing.push(`${lucideName} → ${key}`);
      kept.push(lucideName);
      continue;
    }
    const paths = pathData(icon.body);
    if (!paths) {
      notPaths.push(key);
      kept.push(lucideName);
      continue;
    }
    glyphs.set(fluentName, paths);
  }
  resolved[lucideName] = fluentName;
}

const viewBox = `0 0 ${collection.width ?? 20} ${collection.height ?? 20}`;
const glyphNames = [...glyphs.keys()].sort();
const exportNames = Object.keys(MAP).sort();

const lines: string[] = [];
lines.push(`/**
 * GENERATED by \`bun scripts/gen-product-icons.ts\` — do not edit.
 *
 * Every icon name the app's chrome imports, drawn from Fluent System Icons
 * (20px Regular, MIT, microsoft/fluentui-system-icons) where there is an
 * equivalent and re-exported from lucide where there is not. Import from
 * \`@/lib/icons\`, never from \`lucide-react\` — \`tests/unit/web/product-icons.test.ts\`
 * enforces that, because a file that keeps the old import silently renders a
 * different icon set beside this one.
 */
import { fluentIcon } from "./fluent-icon";

/** Path data, keyed by Fluent's own name so two aliases share one glyph. */
const D: Record<string, readonly string[]> = {`);
for (const name of glyphNames) {
  lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(glyphs.get(name))},`);
}
lines.push(`};

export const ICON_VIEW_BOX = ${JSON.stringify(viewBox)};

/** Which names this module draws with Fluent, for the coverage test. */
export const FLUENT_NAMES: readonly string[] = ${JSON.stringify(Object.keys(resolved).sort())};

/** Which names deliberately stay on lucide, and are asserted to be a short list. */
export const LUCIDE_NAMES: readonly string[] = ${JSON.stringify([...kept].sort())};
`);

const keptSet = new Set(kept);
const reexport = exportNames.filter((n) => keptSet.has(n));
if (reexport.length > 0) {
  lines.push(`export {`);
  for (const n of reexport) lines.push(`  ${n},`);
  lines.push(`} from "lucide-react";`);
  lines.push("");
}
lines.push(`export type { LucideIcon, LucideProps } from "lucide-react";`);
lines.push("");
for (const n of exportNames) {
  const fluentName = resolved[n];
  if (!fluentName) continue;
  lines.push(
    `export const ${n} = fluentIcon(${JSON.stringify(n)}, D[${JSON.stringify(fluentName)}]!);`,
  );
}
lines.push("");

const out = lines.join("\n");
writeFileSync(OUT, out);

const bytes = [...glyphs.values()].reduce(
  (n, ps) => n + ps.reduce((m, p) => m + p.length, 0),
  0,
);
console.log(
  `product icons  ${Object.keys(resolved).length} of ${exportNames.length} names on Fluent  ` +
    `${glyphNames.length} distinct glyphs  ${kept.length} left on lucide`,
);
console.log(
  `               ${(Buffer.byteLength(out) / 1024).toFixed(1)} KiB of module  ` +
    `${(bytes / 1024).toFixed(1)} KiB raw path data`,
);
if (missing.length > 0) console.log(`               NOT IN THE COLLECTION: ${missing.join(", ")}`);
if (notPaths.length > 0) console.log(`               not plain paths: ${notPaths.join(", ")}`);
