/**
 * DBGate's keys on a table's data, while focus is inside the table view. Several are the
 * browser's own (F5 and Ctrl+R reload the page, Ctrl+Shift+R and Ctrl+F5 reload it harder), and
 * some are PPM's (Ctrl+L opens a chat, Ctrl+Shift+E the Source Control panel): inside the view the
 * table's meaning wins, as it does in DBGate.
 *
 * The commands on the selection (`GridKeyCommand`) are narrower still: the grid's own, run by the
 * grid while focus is in it and the command is there to run — anywhere else the key is the
 * browser's (find, history, zoom reset, downloads, DevTools' inspect).
 */
import { eventMatchesCombo, parseCombo } from "@/stores/keybindings-store";

/** DBGate's commands on the grid's selection, which only the grid runs. */
export type GridKeyCommand =
  | "clone-rows" | "set-null" | "find-column" | "hide-columns" | "filter-selected" | "edit-row-json" | "generate-sql";

export type TableKeyCommand =
  | "refresh" | "refresh-structure" | "toggle-auto-refresh"
  | "save" | "new-row" | "delete-rows"
  | "undo" | "redo" | "revert-rows"
  | "toggle-panel" | "clear-filters" | "toggle-form" | "export-advanced"
  | GridKeyCommand;

/**
 * Where the key was pressed: the grid or a button (`view`), a text field such as a filter box
 * (`text`), or a value's editor — the grid's own, or the form view's (`cell-editor`).
 */
export type TableKeyPlace = "view" | "text" | "cell-editor";

const BINDINGS: readonly (readonly [ReturnType<typeof parseCombo>, TableKeyCommand])[] = ([
  ["F5", "refresh"],
  ["Mod+R", "refresh"],
  ["Mod+F5", "refresh-structure"],
  ["Mod+Shift+R", "toggle-auto-refresh"],
  ["Mod+S", "save"],
  ["Insert", "new-row"],
  ["Mod+Delete", "delete-rows"],
  ["Mod+Z", "undo"],
  ["Mod+Y", "redo"],
  // The browser's view-source, here DBGate's Revert row changes.
  ["Mod+U", "revert-rows"],
  ["Mod+L", "toggle-panel"],
  ["Mod+Shift+E", "clear-filters"],
  // DBGate's Switch to form / Switch to table.
  ["F4", "toggle-form"],
  // The browser's search box, here DBGate's Export advanced...
  ["Mod+E", "export-advanced"],
  ["Mod+Shift+C", "clone-rows"],
  ["Mod+0", "set-null"],
  ["Mod+F", "find-column"],
  ["Mod+H", "hide-columns"],
  ["Mod+Shift+F", "filter-selected"],
  ["Mod+J", "edit-row-json"],
  ["Mod+G", "generate-sql"],
] as const).map(([combo, command]) => [parseCombo(combo), command] as const);

const GRID_COMMANDS: ReadonlySet<TableKeyCommand> = new Set<GridKeyCommand>([
  "clone-rows", "set-null", "find-column", "hide-columns", "filter-selected", "edit-row-json", "generate-sql",
]);

export function isGridKeyCommand(command: TableKeyCommand): command is GridKeyCommand {
  return GRID_COMMANDS.has(command);
}

/**
 * Keys a text field has a use for: Insert and Ctrl+Delete edit the text, Ctrl+Z and Ctrl+Y undo its
 * typing, Ctrl+S would save a half-typed value.
 */
const TYPING: ReadonlySet<TableKeyCommand> = new Set(["save", "new-row", "delete-rows", "undo", "redo", "revert-rows"]);

/** Held down, these go on stepping, as undo does everywhere. */
const REPEATS: ReadonlySet<TableKeyCommand> = new Set(["undo", "redo"]);

/** The browser's reloads: never let one throw away the unsaved changes. */
const RELOADS: ReadonlySet<TableKeyCommand> = new Set(["refresh", "refresh-structure", "toggle-auto-refresh"]);

/**
 * What the key does here: a command, `swallow` — the browser must not act on it, and nothing
 * else happens — or `null`, which leaves the key to whoever else wants it.
 */
export function tableKeyCommand(e: KeyboardEvent, place: TableKeyPlace): TableKeyCommand | "swallow" | null {
  if (e.isComposing) return null;
  const command = BINDINGS.find(([combo]) => eventMatchesCombo(e, combo))?.[1];
  if (!command) return null;
  if (place === "cell-editor") {
    // Reading the rows again under an open editor would hand its value to whichever row then
    // stands where the edited one did; the page reloading would lose every change instead.
    return RELOADS.has(command) ? "swallow" : null;
  }
  if (place === "text" && TYPING.has(command)) return null;
  // A text field is not the grid: its selection's commands are not there, and the key is the browser's.
  if (place === "text" && GRID_COMMANDS.has(command)) return null;
  // Held down, a toggle would flicker and a refresh restart itself on every repeat.
  return e.repeat && !REPEATS.has(command) ? "swallow" : command;
}

const NOT_TYPED = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

/** An element that takes typing: its keys are its own first. */
export function isTextField(el: Element | null): boolean {
  if (!el) return false;
  // By tag rather than `instanceof`: an element from another window (a pop-out) is not this one's.
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") return !NOT_TYPED.has((el as HTMLInputElement).type);
  return (el as HTMLElement).isContentEditable === true;
}

/** An event's target as an element; duck-typed, since a popped-out tab's elements are another window's. */
export function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === "function" ? target as Element : null;
}

/**
 * A value's editor: Glide's, which it renders in `#portal` rather than inside the grid, and the
 * form view's, which marks itself.
 */
export const CELL_EDITOR_SELECTOR = ".gdg-clip-region, [data-cell-editor]";

/**
 * Where a key landed, seen from the view's root: `null` when it is not the view's — a dialog the
 * view opened is portalled elsewhere, yet its keys still reach the view through React.
 */
export function tableKeyPlace(root: Element, eventTarget: EventTarget | null): TableKeyPlace | null {
  const target = asElement(eventTarget);
  if (!target) return null;
  // The cell editor is portalled too, but its keys reach only the view whose grid opened it.
  if (target.closest(CELL_EDITOR_SELECTOR)) return "cell-editor";
  if (!root.contains(target)) return null;
  return isTextField(target) ? "text" : "view";
}
