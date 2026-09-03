/**
 * The image dragged under the cursor: the entry's own name for a single item, a count badge
 * ("3 items") for a multi-selection.
 *
 * The browser snapshots the element synchronously during `setDragImage`, but it must be in
 * the document and painted at that moment — hence a real, off-screen node rather than a
 * detached one, removed on the next frame once the snapshot is taken.
 */

const GHOST_OFFSET_X = 12;
const GHOST_OFFSET_Y = 12;

export function setEntryDragGhost(dataTransfer: DataTransfer, names: string[]): void {
  if (typeof document === "undefined" || names.length === 0) return;

  const label = names.length === 1 ? names[0]! : `${names.length} items`;
  const ghost = document.createElement("div");
  ghost.textContent = label;
  // Inline styles, not classes: the node lives outside any themed subtree, and the snapshot
  // is taken before a stylesheet-driven class could apply.
  ghost.style.cssText = [
    "position:fixed",
    "top:-1000px",
    "left:-1000px",
    "padding:4px 10px",
    "border-radius:6px",
    "font:500 12px/1.4 var(--x-font, system-ui, sans-serif)",
    "color:var(--text, #fff)",
    "background:var(--panel-2, #2a2a2a)",
    "border:1px solid var(--border, #444)",
    "box-shadow:0 2px 8px rgba(0,0,0,.35)",
    "white-space:nowrap",
    "pointer-events:none",
  ].join(";");
  document.body.appendChild(ghost);

  try {
    dataTransfer.setDragImage(ghost, GHOST_OFFSET_X, GHOST_OFFSET_Y);
  } catch {
    /* setDragImage is unsupported in some embedded webviews — the default ghost is fine */
  }
  // The snapshot is synchronous, so the node can go as soon as this task yields.
  requestAnimationFrame(() => ghost.remove());
}
