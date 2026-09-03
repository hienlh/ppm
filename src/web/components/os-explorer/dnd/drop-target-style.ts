/**
 * The one highlight every claimed drop target draws — a row, a tile, a sidebar place, a
 * breadcrumb crumb, a view background or a project-tree node all use this same ring so the
 * user learns one visual cue instead of a different one per surface. Matches the ring the
 * project tree's own internal drag-over state already drew before this module existed.
 */
export const DROP_TARGET_CLASS = "ring-1 ring-dashed ring-primary bg-primary/10";
