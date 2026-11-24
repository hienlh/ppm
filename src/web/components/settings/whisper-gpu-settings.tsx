/**
 * Whisper's GPU in Settings → Voice: the CPU / NVIDIA build choice at install time, and, once
 * installed, what whisper-cli was seen to run on, the "Use GPU" switch, and the last time a GPU
 * run failed and the message went to the CPU instead.
 *
 * What it says comes from the server's probe of the installed binary, never from the build that
 * was asked for: a CUDA build on a machine whose GPU cannot be used runs on the CPU and says so.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { TEXT_BUTTON } from "@/lib/control-size";
import { cn } from "@/lib/utils";
import { SwitchRow } from "./settings-rows";
import type { SpeechStatus, WhisperBuild, WhisperGpuStatus } from "./whisper-status-types";

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/**
 * Two cards, shown when this host has an NVIDIA card that can load the CUDA build — and whenever
 * the CUDA build is installed, so a host whose card went away can still go back to the CPU one.
 */
export function WhisperBuildChoice({
  gpu, cpuBytes, value, onChange,
}: {
  gpu: WhisperGpuStatus;
  cpuBytes: number | null;
  value: WhisperBuild;
  onChange: (build: WhisperBuild) => void;
}) {
  if (!gpu.cudaBuild && gpu.installedBuild !== "cuda") return null;
  const gpuNote = gpu.cudaBuild
    ? `Uses ${gpu.nvidia?.name ?? "the NVIDIA card"}: under a second per message. About ${gb(gpu.cudaBuild.unpackedBytes)} on disk.`
    : "Installed, but no NVIDIA card that can use it answers right now.";
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">Build</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <BuildOption
          label="CPU"
          size={cpuBytes ? mb(cpuBytes) : null}
          note="Works on any machine. A short message takes about 5 seconds."
          active={value === "cpu"}
          onClick={() => onChange("cpu")}
        />
        <BuildOption
          label="GPU (NVIDIA)"
          size={gpu.cudaBuild ? mb(gpu.cudaBuild.bytes) : null}
          note={gpuNote}
          active={value === "cuda"}
          onClick={() => onChange("cuda")}
        />
      </div>
    </div>
  );
}

function BuildOption({
  label, size, note, active, onClick,
}: { label: string; size: string | null; note: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // A choice card like the model cards beside it, sized by its content (rule 3 does not cover it).
        "flex-1 rounded-lg border px-4 py-3 text-left transition-colors",
        active ? "border-primary ring-2 ring-primary" : "border-border hover:bg-muted/50",
      )}
    >
      <span className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        {size && <span className="text-xs text-muted-foreground">{size}</span>}
      </span>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </button>
  );
}

const usesGpu = (gpu: WhisperGpuStatus) => gpu.backend === "cuda" || gpu.backend === "metal" || gpu.backend === "gpu";

/** One sentence on what Whisper runs on now. */
export function runsOnText(gpu: WhisperGpuStatus): string {
  if (gpu.backend === null) return gpu.probing ? "Checking whether it can use the GPU…" : "Not checked yet.";
  if (usesGpu(gpu)) {
    const kind = gpu.backend === "cuda" ? "CUDA" : gpu.backend === "metal" ? "Metal" : null;
    const what = [gpu.device, kind && `(${kind})`].filter(Boolean).join(" ");
    return gpu.useGpu ? `Runs on the GPU${what ? ` — ${what}` : ""}.` : "GPU turned off — runs on the CPU.";
  }
  if (gpu.installedBuild === "cuda") return "The GPU build is installed but found no GPU it can use, so it runs on the CPU.";
  return "Runs on the CPU.";
}

export function WhisperGpuPanel({ status, onStatus }: { status: SpeechStatus; onStatus: (next: SpeechStatus) => void }) {
  const gpu = status.gpu;
  const [busy, setBusy] = useState(false);
  if (!status.ready || !gpu) return null;

  const call = async (path: string, body?: unknown, failure?: string) => {
    setBusy(true);
    try {
      onStatus(await api.post<SpeechStatus>(path, body));
    } catch (e) {
      toast.error(failure ?? "Could not change the GPU setting", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const suggestGpuBuild = gpu.installedBuild === "cpu" && gpu.cudaBuild;
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm">
          {gpu.probing && <Loader2 className="size-3.5 animate-spin" />}
          {runsOnText(gpu)}
        </p>
        {suggestGpuBuild && (
          <p className="text-xs text-muted-foreground">
            This host has {gpu.nvidia?.name ?? "an NVIDIA card"}. Choose the GPU build below to transcribe in under a second.
          </p>
        )}
        {gpu.probeError && gpu.installedBuild !== "cpu" && (
          <p className="text-xs text-muted-foreground">Last check: {gpu.probeError}</p>
        )}
      </div>

      {usesGpu(gpu) && (
        <SwitchRow
          label="Use GPU"
          note="Off: Whisper leaves the GPU to other work and each message takes several seconds longer."
          checked={gpu.useGpu}
          disabled={busy}
          onChange={(useGpu) => void call("/api/speech/gpu", { useGpu })}
        />
      )}

      {gpu.lastFailure && gpu.useGpu && (
        <p className="text-xs text-warning">
          The GPU failed on {new Date(gpu.lastFailure.at).toLocaleString()} ({gpu.lastFailure.message}), so that message
          was transcribed on the CPU instead.
        </p>
      )}

      {gpu.installedBuild !== "cpu" && (
        <Button
          variant="outline"
          disabled={busy || gpu.probing}
          onClick={() => void call("/api/speech/gpu/check", undefined, "Could not check the GPU")}
          className={cn(TEXT_BUTTON, "cursor-pointer")}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Check again
        </Button>
      )}
    </div>
  );
}
