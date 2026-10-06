/**
 * Where a grid's Save changes dialog lives: mounted once in the app, it shows the save
 * `requestGridSave` asked for, and loads the dialog — Monaco with it — the first time one is.
 */
import { lazy, Suspense } from "react";
import { useGridSave } from "./grid-save-store";

const GridSaveDialog = lazy(() => import("./grid-save-dialog").then((m) => ({ default: m.GridSaveDialog })));

export function GridSaveHost() {
  const pending = useGridSave((s) => s.pending);
  if (!pending) return null;
  return (
    <Suspense fallback={null}>
      {/* Keyed by save: a new one starts from its own script, never the last one's ticks. */}
      <GridSaveDialog key={pending.seq} request={pending.request} seq={pending.seq} />
    </Suspense>
  );
}
