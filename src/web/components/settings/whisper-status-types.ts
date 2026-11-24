/** What `GET /api/speech/status` answers: the install state plus the GPU half (`whisper-gpu-state.ts`). */

export type WhisperBuild = "cpu" | "cuda";

export interface StatusModel {
  id: string;
  label: string;
  note: string;
  bytes: number;
}

export interface InstallJob {
  modelId: string;
  build: WhisperBuild | "system";
  phase: "binary" | "model" | "vad" | "verify" | "gpu";
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
  error: string | null;
}

export interface WhisperGpuStatus {
  /** Offered only when this host has an NVIDIA card whose driver can load the CUDA build. */
  cudaBuild: { bytes: number; unpackedBytes: number } | null;
  nvidia: { name: string; driver: string; cuda: string | null; supportsCudaBuild: boolean } | null;
  installedBuild: WhisperBuild | "system" | null;
  backend: "cuda" | "metal" | "gpu" | "none" | null;
  device: string | null;
  checkedAt: string | null;
  probeError: string | null;
  probing: boolean;
  useGpu: boolean;
  lastFailure: { at: string; message: string } | null;
}

export interface SpeechStatus {
  installable: boolean;
  installHint: string | null;
  binary: { path: string; source: "bundled" | "system" } | null;
  version: string;
  model: StatusModel | null;
  ready: boolean;
  models: StatusModel[];
  install: InstallJob | null;
  /** Download size of the CPU build for this platform, or null when it has none. */
  cpuBuildBytes?: number | null;
  gpu?: WhisperGpuStatus;
}
