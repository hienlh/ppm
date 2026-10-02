/**
 * Wipe or delete an AVD, with the name typed back.
 *
 * Plan Phase 4: "Wipe/Delete có xác nhận tên máy và hậu quả, chỉ khi stopped". All three parts
 * are here and none of them is decoration:
 *
 *  - **The name is typed, not ticked.** These two rows sit next to each other in one list and
 *    every AVD's row looks the same; a checkbox confirms that a dialog was open, not which
 *    device it was open on.
 *  - **The consequence is spelled out** in the device's own terms — what wipe keeps (the AVD and
 *    its settings) against what delete does not.
 *  - **Stopped only**, and the host checks again: this dialog is not offered for a running or
 *    Studio-locked AVD, and the route refuses one anyway, because a list can be a few seconds old.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Input } from "@/components/ui/input";
import { Loader2, TriangleAlert } from "@/lib/icons";
import { useIsMobile } from "@/hooks/use-is-mobile";

export type DestructiveAction = "wipe" | "delete";

export interface AndroidAvdDestroyDialogProps {
  action: DestructiveAction | null;
  avdId: string;
  deviceName: string;
  onCancel: () => void;
  /** It happened; the list should refresh. `freed` is bytes, for wipe only. */
  onDone: (action: DestructiveAction, message: string) => void;
}

export function AndroidAvdDestroyDialog(
  { action, avdId, deviceName, onCancel, onDone }: AndroidAvdDestroyDialogProps,
) {
  const isMobile = useIsMobile();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setTyped(""); setError(null); setBusy(false); }, [action, avdId]);

  if (!action) return null;

  const isDelete = action === "delete";
  const title = isDelete ? "Delete this device" : "Wipe this device";
  // Exact match, not case-insensitive: two AVDs may differ only in case, and this is the one
  // place where guessing which was meant is the wrong kind of help.
  const armed = typed === deviceName && !busy;

  const run = async () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      if (isDelete) {
        await api.del(`/api/android/avds/${encodeURIComponent(avdId)}`, { confirmName: deviceName });
        onDone("delete", `Deleted ${deviceName}`);
      } else {
        const res = await api.post<{ message: string; freedBytes: number }>(
          `/api/android/avds/${encodeURIComponent(avdId)}/wipe`, { confirmName: deviceName },
        );
        onDone("wipe", res.message);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const body = (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed">
        {isDelete ? (
          <>
            <span className="font-medium">{deviceName}</span> and everything in it will be removed
            from disk. The AVD, its settings and its installed apps are gone for good — this is
            not a recycle bin.
          </>
        ) : (
          <>
            Everything inside <span className="font-medium">{deviceName}</span> goes back to
            factory: installed apps, accounts, files and saved snapshots. The device itself and
            its settings stay, and the next start is a cold boot.
          </>
        )}
      </p>

      <div className="space-y-1.5">
        <label htmlFor="avd-confirm" className="text-sm font-medium">
          Type <span className="font-mono">{deviceName}</span> to confirm
        </label>
        <Input
          id="avd-confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          className="h-11 font-mono"
        />
      </div>

      {error && (
        <p className="flex items-start gap-2 text-sm leading-relaxed text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
        <Button variant="outline" className="min-h-11" onClick={onCancel}>Cancel</Button>
        <Button variant="destructive" className="min-h-11" autoFocus={false}
          disabled={!armed} onClick={() => void run()}>
          {busy
            ? <><Loader2 className="animate-spin" /> {isDelete ? "Deleting…" : "Wiping…"}</>
            : (isDelete ? "Delete device" : "Wipe data")}
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onCancel}>
        <div className="px-4 pb-4">
          <h2 className="mb-3 text-base font-semibold">{title}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isDelete ? "This cannot be undone." : "A factory reset — the device itself stays."}
          </DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
