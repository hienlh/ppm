import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { sendToChat } from "@/lib/send-to-chat";
import { codeFence } from "@/lib/code-fence";
import { MessageSquare, MessageSquarePlus } from "@/lib/icons";
import { cn } from "@/lib/utils";

/** The editor's two selection actions, under the same names. */
const CHAT_TARGETS = [
  { title: "Add to current chat", newTab: false, Icon: MessageSquare },
  { title: "Add to new chat", newTab: true, Icon: MessageSquarePlus },
] as const;

/** Between the selection and the actions, in CSS px. */
const GAP = 4;

/** What either action hands over: the selection as one quoted block, without the blank lines around it. */
export function readTerminalSelectionContext(selection: string) {
  const text = selection.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
  if (!text) return null;
  const fence = codeFence(text);
  return { label: "Terminal selection", text: `Selected text from the terminal\n${fence}\n${text}\n${fence}` };
}

export interface SelectionLayout {
  /** As `getSelectionPosition()` reports it: 0-based columns and buffer rows, the end exclusive. */
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** The buffer row at the top of the viewport. */
  viewportY: number;
  rows: number;
  cols: number;
  cell: { width: number; height: number };
  /** The terminal's screen, relative to the box the actions are positioned in. */
  screen: { left: number; top: number };
  box: { width: number; height: number };
  actions: { width: number; height: number };
}

/**
 * Under the selection's last row, from the column it ends at — where the pointer that made it
 * was released — or over its first row when there is no room under it. Null when none of it is
 * on screen: actions pointing at nothing in view read as stray.
 */
export function placeSelectionActions(layout: SelectionLayout): { left: number; top: number } | null {
  const { start, cell, screen, box, actions } = layout;
  // A drag that stops at the start of a line ends there but selects nothing on it.
  const end = layout.end.x === 0 && layout.end.y > start.y ? { x: layout.cols, y: layout.end.y - 1 } : layout.end;
  const first = start.y - layout.viewportY;
  const last = end.y - layout.viewportY;
  if (last < 0 || first >= layout.rows) return null;
  const maxTop = box.height - actions.height;
  let top = screen.top + (Math.min(last, layout.rows - 1) + 1) * cell.height + GAP;
  if (top > maxTop) {
    const above = screen.top + Math.max(first, 0) * cell.height - actions.height - GAP;
    top = above >= 0 ? above : maxTop;
  }
  const left = Math.min(screen.left + end.x * cell.width, box.width - actions.width);
  return { left: Math.max(0, left), top: Math.max(0, top) };
}

/**
 * "Add to current chat" and "Add to new chat" beside a terminal selection, as the editor offers
 * them for a code selection and as Cursor shows its Add to Chat. xterm reports a selection when
 * the mouse — or, in select mode, the finger — is released and not during the drag, so the
 * actions appear once the selection is made, and go when it is cleared.
 *
 * Rendered beside xterm's container rather than in it: in select mode that container turns every
 * touch into a selection gesture, which would swallow a tap on the buttons.
 */
export function TerminalSelectionChat({ terminal, projectName, touch }: {
  terminal: Terminal | null;
  projectName?: string;
  /** Finger-sized targets. */
  touch: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  // Moved by hand rather than through React state: it follows every scroll and every frame of
  // output that shifts the selected rows.
  const place = useCallback(() => {
    const el = ref.current;
    const box = el?.offsetParent;
    const range = terminal?.getSelectionPosition();
    const cell = terminal?.dimensions?.css.cell;
    const screen = terminal?.element?.querySelector(".xterm-screen");
    if (!el || !box || !terminal || !range || !cell || !screen) return;
    const boxRect = box.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const at = placeSelectionActions({
      start: range.start,
      end: range.end,
      viewportY: terminal.buffer.active.viewportY,
      rows: terminal.rows,
      cols: terminal.cols,
      cell,
      screen: { left: screenRect.left - boxRect.left, top: screenRect.top - boxRect.top },
      box: { width: boxRect.width, height: boxRect.height },
      actions: { width: el.offsetWidth, height: el.offsetHeight },
    });
    el.style.visibility = at ? "visible" : "hidden";
    if (at) el.style.transform = `translate(${Math.round(at.left)}px, ${Math.round(at.top)}px)`;
  }, [terminal]);

  useEffect(() => {
    const element = terminal?.element;
    if (!terminal || !element) return;
    const sync = () => {
      setShown(!!terminal.getSelection().trim());
      place();
    };
    // xterm says nothing about a selection identical to the last one it reported, and its
    // clearSelection() — which it also runs itself when the user types — does not forget that
    // one. So selecting the same text again after typing, or after adding it, would show nothing:
    // the released pointer reads the selection instead, once xterm's own mouseup has finalised it.
    let released: Document | undefined;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const onRelease = () => {
      released = undefined;
      clearTimeout(pending);
      pending = setTimeout(sync, 0);
    };
    // The document the drag ends in is the element's at the time: a tab can be moved into a
    // picture-in-picture window after it mounted.
    const onPress = () => {
      released?.removeEventListener("mouseup", onRelease, true);
      released = element.ownerDocument;
      released.addEventListener("mouseup", onRelease, { capture: true, once: true });
    };
    element.addEventListener("mousedown", onPress, true);
    // A scroll, a resize and new output all end in a render of the rows.
    const subscriptions = [terminal.onSelectionChange(sync), terminal.onRender(place)];
    return () => {
      element.removeEventListener("mousedown", onPress, true);
      released?.removeEventListener("mouseup", onRelease, true);
      clearTimeout(pending);
      subscriptions.forEach((subscription) => subscription.dispose());
    };
  }, [terminal, place]);

  // Measured and placed in the frame it first exists, before it is painted.
  useLayoutEffect(() => {
    if (shown) place();
  }, [shown, place]);

  if (!shown || !terminal) return null;

  const add = (newTab: boolean) => {
    const context = readTerminalSelectionContext(terminal.getSelection());
    if (context) sendToChat({ ...context, projectName, newTab, asContext: true });
    terminal.clearSelection();
  };

  return (
    <div
      ref={ref}
      role="group"
      aria-label="Add the selection to chat"
      className="invisible absolute left-0 top-0 z-10 flex max-w-full flex-wrap gap-1 rounded-md border border-border bg-surface p-0.5 shadow-md"
    >
      {CHAT_TARGETS.map(({ title, newTab, Icon }) => (
        <button
          key={title}
          type="button"
          onClick={() => add(newTab)}
          className={cn(
            "flex items-center gap-1 whitespace-nowrap rounded bg-surface-elevated text-text-primary transition-colors hover:bg-primary hover:text-primary-foreground active:bg-primary active:text-primary-foreground",
            touch ? "min-h-11 px-3 text-sm" : "px-2 py-0.5 text-xs",
          )}
        >
          <Icon size={touch ? 16 : 12} />
          {title}
        </button>
      ))}
    </div>
  );
}
