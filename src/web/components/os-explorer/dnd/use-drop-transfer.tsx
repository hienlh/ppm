/**
 * A self-contained transfer runner for the drop surfaces that live outside an explorer
 * window's action set: the places sidebar, the breadcrumb and the project file tree.
 *
 * Those three are rendered by components that never receive `ExplorerActions`, so they own
 * the two interruptions `transfer()` can raise (name collision, and a Replace on a host with
 * no Trash) themselves. The dialogs are the very same components the window body renders —
 * only the promise wiring is local — so a collision looks identical wherever the drop landed.
 */

import { useMemo, useRef, useState, type ReactNode } from "react";
import type { CollisionChoice, CollisionRequest, TransferContext } from "../actions/explorer-actions-clipboard";
import type { ExplorerDialogState } from "../actions/use-explorer-actions";
import { ExplorerDialogs } from "../explorer-dialogs";
import { transferRunner, type DropRunner } from "./entry-drop-executor";

export interface DropTransfer {
  run: DropRunner;
  /** Render this somewhere inside the surface — it is empty until a prompt is raised. */
  prompts: ReactNode;
}

export function useDropTransfer(sep: string, platform?: string): DropTransfer {
  const [collision, setCollision] = useState<ExplorerDialogState["collision"]>(null);
  const [permanentOverwrite, setPermanentOverwrite] = useState<ExplorerDialogState["permanentOverwrite"]>(null);

  // The separator can change under a long-lived surface (the tree follows the active
  // project), so the context reads it live rather than closing over the first value.
  const sepRef = useRef(sep);
  sepRef.current = sep;

  const context = useMemo<TransferContext>(
    () => ({
      get sep() {
        return sepRef.current;
      },
      resolve: (request: CollisionRequest) =>
        new Promise<CollisionChoice>((resolve) => {
          setCollision({
            ...request,
            resolve: (choice) => {
              setCollision(null);
              resolve(choice);
            },
          });
        }),
      confirmPermanentOverwrite: (name: string) =>
        new Promise<boolean>((resolve) => {
          setPermanentOverwrite({
            name,
            resolve: (proceed) => {
              setPermanentOverwrite(null);
              resolve(proceed);
            },
          });
        }),
    }),
    [],
  );

  const run = useMemo<DropRunner>(() => transferRunner(context), [context]);

  const prompts = (
    <ExplorerDialogs
      dialogs={{
        collision,
        permanentOverwrite,
        pendingDelete: null,
        properties: null,
        inlineError: null,
        closeDelete: () => {},
        runPermanentDelete: () => {},
        closeProperties: () => {},
      }}
      platform={platform}
      sep={sep}
    />
  );

  return { run, prompts };
}
