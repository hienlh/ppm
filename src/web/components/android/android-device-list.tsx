/**
 * The device picker: what AVDs exist, which are running, and what is stopping the rest.
 *
 * Plan §6 is explicit that the empty state must say *which* thing is missing — no SDK, no
 * emulator binary, no system image, no AVD, no usable acceleration — and never show an
 * indefinite spinner. That is what `/capabilities` returns, one row per requirement with the
 * command that fixes it, so the answer is the same one the user would get from a terminal.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Loader2, Play, Square, RefreshCw, TriangleAlert, Smartphone, Check, Plus, Trash2, RotateCcw,
  MoreVertical,
} from "@/lib/icons";
import { cn } from "@/lib/utils";
import { AndroidAvdCreateDialog } from "./android-avd-create-dialog";
import { AndroidAvdDestroyDialog, type DestructiveAction } from "./android-avd-destroy-dialog";

interface Requirement { id: string; label: string; met: boolean; detail: string; fix: string | null }
interface Capabilities {
  enabled: boolean;
  ready: boolean;
  avdCount: number;
  accelerationOk: boolean;
  accelerationDetail: string;
  requirements: Requirement[];
  encoders: string[];
  /** False when the SDK command-line tools are missing — there is no `avdmanager` to call. */
  canCreateAvd: boolean;
}
interface Runtime { deviceId: string; generation: number; adbSerial: string | null; ownedByPpm: boolean }
export interface DeviceRow {
  avdId: string;
  name: string;
  apiLevel: number | null;
  abi: string | null;
  displayWidth: number | null;
  displayHeight: number | null;
  hardwareKeyboard: boolean;
  lockedByAnotherProcess: boolean;
  state: string;
  runtime: Runtime | null;
}

export interface AndroidDeviceListProps {
  onOpen: (device: DeviceRow) => void;
}

/** A cold boot is minutes, not seconds, so the start route answers with an operation id and this
 *  polls it. Slow enough not to be chatty, fast enough that "Ready" is not stale. */
const POLL_MS = 1_500;

export function AndroidDeviceList({ onOpen }: AndroidDeviceListProps) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [destroy, setDestroy] = useState<{ action: DestructiveAction; device: DeviceRow } | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const c = await api.get<Capabilities>("/api/android/capabilities");
      if (!mounted.current) return;
      setCaps(c);
      if (!c.enabled) return;
      const d = await api.get<{ devices: DeviceRow[] }>("/api/android/devices");
      if (!mounted.current) return;
      setDevices(d.devices);
      setError(null);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS * 4);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [refresh]);

  const start = useCallback(async (device: DeviceRow) => {
    setBusy((b) => ({ ...b, [device.avdId]: "Starting…" }));
    try {
      const { operationId } = await api.post<{ operationId: string }>(
        `/api/android/avds/${encodeURIComponent(device.avdId)}/start`, {},
      );
      // Poll to completion. A boot is long enough that the user needs to see it progressing,
      // which is what `detail` carries.
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (!mounted.current) return;
        const op = await api.get<{ state: string; detail?: string; error?: string }>(
          `/api/android/operations/${operationId}`,
        );
        setBusy((b) => ({ ...b, [device.avdId]: op.detail ?? "Starting…" }));
        if (op.state === "succeeded") break;
        if (op.state === "failed" || op.state === "cancelled") {
          setError(op.error ?? "the emulator failed to start");
          break;
        }
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) {
        setBusy((b) => { const next = { ...b }; delete next[device.avdId]; return next; });
        void refresh();
      }
    }
  }, [refresh]);

  const stop = useCallback(async (device: DeviceRow) => {
    if (!device.runtime) return;
    setBusy((b) => ({ ...b, [device.avdId]: "Stopping…" }));
    try {
      // The generation the client last saw: a stop must not take down a run that has since
      // restarted under the same name.
      await api.post(
        `/api/android/devices/${encodeURIComponent(device.runtime.deviceId)}/stop?generation=${device.runtime.generation}`,
        {},
      );
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) {
        setBusy((b) => { const next = { ...b }; delete next[device.avdId]; return next; });
        void refresh();
      }
    }
  }, [refresh]);

  if (!caps) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Checking this host…
      </div>
    );
  }

  const unmet = caps.requirements.filter((r) => !r.met);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Smartphone className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">Android devices</h2>
        {caps.canCreateAvd && (
          <Button size="sm" className="h-10" onClick={() => setCreating(true)}>
            <Plus /> New device
          </Button>
        )}
        <Button variant="ghost" size="icon" className="size-10" onClick={() => void refresh()}
          title="Refresh" aria-label="Refresh">
          <RefreshCw />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1 leading-relaxed">{error}</span>
          </div>
        )}

        {unmet.length > 0 && (
          <div className="mb-4 rounded-md border p-4">
            <p className="text-sm font-medium">This host is not ready yet</p>
            <ul className="mt-3 space-y-3">
              {caps.requirements.map((r) => (
                <li key={r.id} className="flex items-start gap-2 text-sm leading-relaxed">
                  {r.met
                    ? <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />}
                  <span className="min-w-0 flex-1">
                    <span className={cn(!r.met && "font-medium")}>{r.label}</span>
                    <span className="block text-muted-foreground">{r.detail}</span>
                    {!r.met && r.fix && (
                      // A command to run, not a button: PPM never installs an SDK on the user's
                      // behalf, and the plan's §6 empty state is meant to be actionable in a
                      // terminal.
                      <code className="mt-1 block overflow-x-auto rounded bg-muted px-2 py-1 text-xs">
                        {r.fix}
                      </code>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {devices.length === 0 && unmet.length === 0 && (
          <div className="py-8 text-center">
            <p className="text-sm leading-relaxed text-muted-foreground">
              No AVDs on this host yet.
            </p>
            {caps.canCreateAvd ? (
              <Button className="mt-4 min-h-11" onClick={() => setCreating(true)}>
                <Plus /> New device
              </Button>
            ) : (
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Create one in Android Studio, or with{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">avdmanager create avd</code>.
              </p>
            )}
          </div>
        )}

        <ul className="space-y-2">
          {devices.map((device) => {
            const running = device.runtime !== null;
            const label = busy[device.avdId];
            return (
              <li key={device.avdId}
                className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{device.name}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {[
                      device.apiLevel ? `API ${device.apiLevel}` : null,
                      device.abi,
                      device.displayWidth && device.displayHeight
                        ? `${device.displayWidth}x${device.displayHeight}` : null,
                      running ? (device.runtime!.ownedByPpm ? "running (PPM)" : "running (external)") : null,
                    ].filter(Boolean).join(" · ")}
                  </p>
                  {device.lockedByAnotherProcess && (
                    <p className="mt-1 text-xs leading-relaxed text-destructive">
                      Locked by another process — it is probably open in Android Studio.
                    </p>
                  )}
                  {!device.hardwareKeyboard && (
                    // Measured in Phase 0: with `hw.keyboard=no` the gRPC `sendKey` call returns
                    // OK and does nothing at all, so this has to be said rather than debugged.
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      This AVD has no hardware keyboard, so typing will not reach it. Set{" "}
                      <code className="rounded bg-muted px-1 text-[11px]">hw.keyboard=yes</code> in its config.ini.
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {label && (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" /> {label}
                    </span>
                  )}
                  {running ? (
                    <>
                      <Button size="sm" className="h-10" onClick={() => onOpen(device)}>View</Button>
                      {device.runtime!.ownedByPpm && (
                        <Button size="sm" variant="outline" className="h-10"
                          disabled={!!label} onClick={() => void stop(device)}>
                          <Square /> Stop
                        </Button>
                      )}
                    </>
                  ) : (
                    <Button size="sm" className="h-10"
                      disabled={!!label || device.lockedByAnotherProcess || !caps.ready}
                      onClick={() => void start(device)}>
                      <Play /> Start
                    </Button>
                  )}

                  {/* A visible button rather than a right-click or a long press: wipe and delete
                      have no other route to them, and a hidden gesture is not a route. It is its
                      own control, so it never takes the row's own tap away. */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-11 md:size-10"
                        title={`More for ${device.name}`} aria-label={`More for ${device.name}`}>
                        <MoreVertical />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {/* Destructive items are offered only while the AVD is stopped and nothing
                          else holds its lock — the same rule the host enforces, said up front
                          rather than as a refusal after the name has been typed. */}
                      <DropdownMenuItem
                        className="min-h-11 md:min-h-0"
                        disabled={running || device.lockedByAnotherProcess || !!label}
                        onSelect={() => setDestroy({ action: "wipe", device })}
                      >
                        <RotateCcw /> Wipe data
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        className="min-h-11 md:min-h-0"
                        disabled={running || device.lockedByAnotherProcess || !!label || !caps.canCreateAvd}
                        onSelect={() => setDestroy({ action: "delete", device })}
                      >
                        <Trash2 /> Delete device
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <AndroidAvdCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        existingNames={devices.map((d) => d.name)}
        onCreated={(name) => { toast.success(`Created ${name}`); void refresh(); }}
      />
      <AndroidAvdDestroyDialog
        action={destroy?.action ?? null}
        avdId={destroy?.device.avdId ?? ""}
        deviceName={destroy?.device.name ?? ""}
        onCancel={() => setDestroy(null)}
        onDone={(_action, message) => { setDestroy(null); toast.success(message); void refresh(); }}
      />
    </div>
  );
}
