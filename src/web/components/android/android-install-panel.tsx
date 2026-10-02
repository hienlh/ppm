/**
 * Install an APK on this device: either one the browser uploads, or one already on the host.
 *
 * Both paths end in the same typed endpoint and the same operation poll, and neither of them
 * ever names an adb argument — the browser says "this device, this file" and nothing more.
 *
 * The project path exists because the common case is not a download: it is an APK Gradle just
 * wrote into the project PPM already has open, and making the user find it on disk, upload it
 * back to the machine it is already on, and wait for 80 MB to cross the LAN twice would be
 * absurd.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, getAuthToken } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Loader2, TriangleAlert, Check, Upload, X, RefreshCw } from "@/lib/icons";
import { useProjectStore } from "@/stores/project-store";
import { cn } from "@/lib/utils";
import { uploadApk, type ApkUploadHandle } from "./android-apk-upload";

const POLL_MS = 800;

interface ProjectApk { path: string; bytes: number; modifiedAt: number }
interface OperationView { state: string; detail: string; error: string | null }

export interface AndroidInstallPanelProps {
  deviceId: string;
  deviceName: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; fraction: number; filename: string }
  | { kind: "installing"; operationId: string; detail: string; filename: string }
  | { kind: "done"; filename: string }
  | { kind: "failed"; message: string };

export function AndroidInstallPanel({ deviceId, deviceName }: AndroidInstallPanelProps) {
  const projects = useProjectStore((s) => s.projects);
  const [projectName, setProjectName] = useState<string>("");
  const [apks, setApks] = useState<ProjectApk[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [allowDowngrade, setAllowDowngrade] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadRef = useRef<ApkUploadHandle | null>(null);
  // Read by the poll loop, which is created once and would otherwise see the phase from the
  // render that started it.
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const busy = phase.kind === "uploading" || phase.kind === "installing";

  /** Poll one install to its end. Cancel is a separate typed call, not an abort of this. */
  const watchOperation = useCallback(async (operationId: string, filename: string) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      // Stop if this install is no longer the one on screen — cancelled, or replaced by a second
      // one the user started. Checking only the *kind* would let two loops write over each other.
      const now = phaseRef.current;
      if (now.kind !== "installing" || now.operationId !== operationId) return;
      let op: OperationView;
      try {
        op = await api.get<OperationView>(`/api/android/operations/${encodeURIComponent(operationId)}`);
      } catch (e) {
        setPhase({ kind: "failed", message: (e as Error).message });
        return;
      }
      if (op.state === "succeeded") { setPhase({ kind: "done", filename }); return; }
      if (op.state === "failed") { setPhase({ kind: "failed", message: op.error ?? "the install failed" }); return; }
      if (op.state === "cancelled") { setPhase({ kind: "idle" }); return; }
      setPhase({ kind: "installing", operationId, detail: op.detail, filename });
    }
  }, []);

  const onFile = useCallback((file: File) => {
    setPhase({ kind: "uploading", fraction: 0, filename: file.name });
    const handle = uploadApk({
      deviceId, file, allowDowngrade, token: getAuthToken(),
      onProgress: (fraction) => setPhase({ kind: "uploading", fraction, filename: file.name }),
    });
    uploadRef.current = handle;
    void handle.done
      .then((operationId) => {
        uploadRef.current = null;
        setPhase({ kind: "installing", operationId, detail: "installing…", filename: file.name });
        void watchOperation(operationId, file.name);
      })
      .catch((e: Error) => {
        uploadRef.current = null;
        // A cancel is the user's own doing and needs no red box.
        setPhase(e.message === "cancelled" ? { kind: "idle" } : { kind: "failed", message: e.message });
      });
  }, [deviceId, allowDowngrade, watchOperation]);

  const installFromProject = useCallback(async (path: string) => {
    const filename = path.split("/").pop() ?? path;
    setPhase({ kind: "installing", operationId: "", detail: "starting…", filename });
    try {
      const { operationId } = await api.post<{ operationId: string }>(
        `/api/android/devices/${encodeURIComponent(deviceId)}/apk/project`,
        { project: projectName, path, downgrade: allowDowngrade },
      );
      setPhase({ kind: "installing", operationId, detail: "installing…", filename });
      void watchOperation(operationId, filename);
    } catch (e) {
      setPhase({ kind: "failed", message: (e as Error).message });
    }
  }, [deviceId, projectName, allowDowngrade, watchOperation]);

  const cancel = useCallback(() => {
    if (phase.kind === "uploading") { uploadRef.current?.cancel(); return; }
    if (phase.kind === "installing" && phase.operationId) {
      void api.post(`/api/android/operations/${encodeURIComponent(phase.operationId)}/cancel`, {})
        .catch(() => { /* it finished first; the poll will say so */ });
      setPhase({ kind: "idle" });
    }
  }, [phase]);

  const scan = useCallback(async (name: string) => {
    if (!name) { setApks(null); return; }
    setScanning(true);
    try {
      const res = await api.get<{ apks: ProjectApk[] }>(`/api/android/projects/${encodeURIComponent(name)}/apks`);
      setApks(res.apks);
    } catch {
      setApks([]);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => { void scan(projectName); }, [projectName, scan]);
  useEffect(() => () => uploadRef.current?.cancel(), []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
      <p className="text-xs text-muted-foreground">Installing on {deviceName}.</p>

      {/* --- upload ------------------------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";                 // so choosing the same file twice fires again
            if (file) onFile(file);
          }}
        />
        <Button className="h-11 md:h-9" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload /> Choose an APK
        </Button>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm md:min-h-9">
          <input
            type="checkbox"
            className="size-4"
            checked={allowDowngrade}
            disabled={busy}
            onChange={(e) => setAllowDowngrade(e.target.checked)}
          />
          Allow downgrade
        </label>
      </div>

      <PhaseView phase={phase} onCancel={cancel} onDismiss={() => setPhase({ kind: "idle" })} />

      {/* --- from a project ---------------------------------------------------------------- */}
      <div className="flex flex-col gap-2 border-t pt-3">
        <div className="flex items-center gap-2">
          <label className="text-sm" htmlFor="android-apk-project">From a project</label>
          <select
            id="android-apk-project"
            className="h-11 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm md:h-9"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
          >
            <option value="">Choose a project…</option>
            {projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          {projectName && (
            <Button variant="ghost" size="icon" className="size-11 md:size-9" disabled={scanning}
              onClick={() => void scan(projectName)} title="Rescan" aria-label="Rescan">
              {scanning ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
          )}
        </div>

        {scanning && <p className="text-sm text-muted-foreground">Looking for APKs…</p>}
        {!scanning && apks?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No .apk files in that project yet — build one and press rescan.
          </p>
        )}
        {!scanning && apks && apks.length > 0 && (
          <ul className="flex flex-col gap-1">
            {apks.map((apk) => (
              <li key={apk.path}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void installFromProject(apk.path)}
                  className={cn(
                    "flex min-h-11 w-full flex-col items-start rounded-md border px-3 py-2 text-left text-sm md:min-h-9",
                    busy ? "opacity-50" : "hover:bg-accent",
                  )}
                >
                  {/* Filenames differ at the end, so the head is what gets cut (CLAUDE.md). */}
                  <span dir="rtl" className="w-full truncate"><bdi>{apk.path}</bdi></span>
                  <span className="text-xs text-muted-foreground">
                    {formatBytes(apk.bytes)} · {new Date(apk.modifiedAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PhaseView({ phase, onCancel, onDismiss }: { phase: Phase; onCancel: () => void; onDismiss: () => void }) {
  if (phase.kind === "idle") return null;

  if (phase.kind === "uploading" || phase.kind === "installing") {
    const percent = phase.kind === "uploading" ? Math.round(phase.fraction * 100) : null;
    const detail = phase.kind === "installing" ? phase.detail : "";
    return (
      <div className="flex flex-col gap-2 rounded-md border p-3">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 shrink-0 animate-spin" />
          <span dir="rtl" className="min-w-0 flex-1 truncate"><bdi>{phase.filename}</bdi></span>
          <Button variant="ghost" size="icon" className="size-9" onClick={onCancel}
            title="Cancel" aria-label="Cancel">
            <X />
          </Button>
        </div>
        {percent !== null ? (
          <>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">Uploading — {percent}%</p>
          </>
        ) : (
          // adb has no percentage to report, so the panel does not invent one.
          <p className="text-xs text-muted-foreground">{detail}</p>
        )}
      </div>
    );
  }

  if (phase.kind === "done") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-600/40 bg-emerald-600/10 p-3 text-sm">
        <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span dir="rtl" className="min-w-0 flex-1 truncate"><bdi>{phase.filename}</bdi></span>
        <span className="shrink-0 text-muted-foreground">installed</span>
        <Button variant="ghost" size="icon" className="size-9" onClick={onDismiss} aria-label="Dismiss"><X /></Button>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1">{phase.message}</span>
      <Button variant="ghost" size="icon" className="size-9" onClick={onDismiss} aria-label="Dismiss"><X /></Button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
