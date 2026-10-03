/**
 * Where the Save changes dialog lives: mounted once in the app, it shows the request
 * `requestStructureChange` made — and before it, for a rename, "Rename object" — and loads the
 * dialogs, Monaco with them, the first time one is asked for.
 */
import { lazy, Suspense } from "react";
import { useStructureSave } from "./structure-save-store";

const StructureSaveDialog = lazy(() => import("./structure-save-dialog").then((m) => ({ default: m.StructureSaveDialog })));
const RenameObjectDialog = lazy(() => import("./rename-object-dialog").then((m) => ({ default: m.RenameObjectDialog })));

export function StructureSaveHost() {
  const request = useStructureSave((s) => s.request);
  const seq = useStructureSave((s) => s.seq);
  const rename = useStructureSave((s) => s.rename);
  if (!request && !rename) return null;
  return (
    <Suspense fallback={null}>
      {/* Keyed by request: a new one starts from its own script, never the last one's. */}
      {request && <StructureSaveDialog key={seq} request={request} seq={seq} />}
      {rename && !request && <RenameObjectDialog request={rename} />}
    </Suspense>
  );
}
