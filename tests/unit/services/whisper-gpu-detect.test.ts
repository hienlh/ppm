import { describe, expect, it } from "bun:test";
import type { Runner } from "../../../src/services/host-info/spawn-runner.ts";
import {
  cudaAtLeast,
  parseCudaVersion,
  parseGpuQuery,
  parseWhisperBackend,
  queryNvidiaGpu,
} from "../../../src/services/speech-to-text/whisper-gpu-detect.ts";

describe("nvidia-smi parsing", () => {
  it("reads the CUDA version in both banner spellings", () => {
    // Drivers up to the 570s, and the newer banner with a KMD version beside it.
    expect(parseCudaVersion("| NVIDIA-SMI 551.61   Driver Version: 551.61   CUDA Version: 12.4 |")).toEqual([12, 4]);
    expect(parseCudaVersion("| NVIDIA-SMI 610.88   KMD Version: 610.88   CUDA UMD Version: 13.3 |")).toEqual([13, 3]);
    expect(parseCudaVersion("no banner here")).toBeNull();
  });

  it("compares against CUDA 12.4, the version the build is made for", () => {
    expect(cudaAtLeast([12, 4])).toBe(true);
    expect(cudaAtLeast([13, 0])).toBe(true);
    expect(cudaAtLeast([12, 3])).toBe(false);
    expect(cudaAtLeast([11, 8])).toBe(false);
  });

  it("takes the first card of the CSV query", () => {
    expect(parseGpuQuery("NVIDIA GeForce RTX 4070, 610.88\r\nNVIDIA T400, 610.88\r\n")).toEqual({
      name: "NVIDIA GeForce RTX 4070", driver: "610.88",
    });
    expect(parseGpuQuery("")).toBeNull();
    expect(parseGpuQuery("no comma")).toBeNull();
  });
});

const fakeRunner = (answers: Record<string, { stdout: string; code: number | null }>): Runner =>
  async (argv) => {
    const answer = answers[argv.slice(1).join(" ")] ?? { stdout: "", code: null };
    return { stdout: answer.stdout, stderr: answer.code === null ? "Executable not found in $PATH" : "", code: answer.code, timedOut: false };
  };

describe("queryNvidiaGpu", () => {
  const QUERY = "--query-gpu=name,driver_version --format=csv,noheader";

  it("is null on a host without the NVIDIA driver", async () => {
    expect(await queryNvidiaGpu(fakeRunner({}))).toBeNull();
  });

  it("offers the CUDA build to a driver reporting CUDA 12.4 or newer", async () => {
    const gpu = await queryNvidiaGpu(fakeRunner({
      [QUERY]: { stdout: "NVIDIA GeForce RTX 4070, 610.88\n", code: 0 },
      "": { stdout: "| KMD Version: 610.88   CUDA UMD Version: 13.3 |", code: 0 },
    }));
    expect(gpu).toEqual({ name: "NVIDIA GeForce RTX 4070", driver: "610.88", cuda: "13.3", supportsCudaBuild: true });
  });

  it("names the card but does not offer the build to an older driver", async () => {
    const gpu = await queryNvidiaGpu(fakeRunner({
      [QUERY]: { stdout: "NVIDIA GeForce GTX 1060, 537.13\n", code: 0 },
      "": { stdout: "| Driver Version: 537.13   CUDA Version: 12.2 |", code: 0 },
    }));
    expect(gpu?.name).toBe("NVIDIA GeForce GTX 1060");
    expect(gpu?.supportsCudaBuild).toBe(false);
  });
});

describe("parseWhisperBackend", () => {
  it("reads a CUDA run, with the card's name", () => {
    const log = [
      "ggml_cuda_init: found 1 CUDA devices (Total VRAM: 12281 MiB):",
      "  Device 0: NVIDIA GeForce RTX 4070, compute capability 8.9, VMM: yes, VRAM: 12281 MiB",
      "whisper_backend_init_gpu: found GPU device 0: CUDA0 (type: 1, cnt: 0)",
      "whisper_backend_init_gpu: using CUDA0 backend",
    ].join("\n");
    expect(parseWhisperBackend(log)).toEqual({ backend: "cuda", device: "NVIDIA GeForce RTX 4070" });
  });

  it("reads a Metal run", () => {
    const log = "ggml_metal_init: GPU name:   Apple M2 Pro\nwhisper_backend_init_gpu: using MTL0 backend\n";
    expect(parseWhisperBackend(log)).toEqual({ backend: "metal", device: "Apple M2 Pro" });
  });

  it("reads a CUDA build that found no GPU — the case that otherwise passes silently", () => {
    const log = "ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected\nwhisper_backend_init_gpu: no GPU found\n";
    expect(parseWhisperBackend(log)).toEqual({ backend: "none", device: null });
  });

  it("calls an unnamed GPU backend a GPU", () => {
    expect(parseWhisperBackend("whisper_backend_init_gpu: using Vulkan0 backend")?.backend).toBe("gpu");
  });

  it("is null when the run died before choosing", () => {
    expect(parseWhisperBackend("error: failed to open model")).toBeNull();
  });
});
