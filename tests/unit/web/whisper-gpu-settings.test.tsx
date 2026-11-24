/**
 * Settings → Voice, Whisper's GPU: what the pane says Whisper runs on, the CPU / NVIDIA build
 * choice, and the Use GPU switch.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { WhisperBuildChoice, WhisperGpuPanel, runsOnText } = await import("../../../src/web/components/settings/whisper-gpu-settings");
const { api } = await import("../../../src/web/lib/api-client");
import type { SpeechStatus, WhisperGpuStatus } from "../../../src/web/components/settings/whisper-status-types";

const gpu = (over: Partial<WhisperGpuStatus> = {}): WhisperGpuStatus => ({
  cudaBuild: { bytes: 674_539_285, unpackedBytes: 1_191_220_736 },
  nvidia: { name: "NVIDIA GeForce RTX 4070", driver: "610.88", cuda: "13.3", supportsCudaBuild: true },
  installedBuild: "cuda",
  backend: "cuda",
  device: "NVIDIA GeForce RTX 4070",
  checkedAt: "2026-11-24T08:00:00Z",
  probeError: null,
  probing: false,
  useGpu: true,
  lastFailure: null,
  ...over,
});

const status = (g: WhisperGpuStatus): SpeechStatus => ({
  installable: true, installHint: null, binary: { path: "x", source: "bundled" }, version: "1.9.4",
  model: { id: "large-v3-turbo-q5_0", label: "Large v3 Turbo", note: "", bytes: 1 }, ready: true, models: [],
  install: null, cpuBuildBytes: 8_573_270, gpu: g,
});

describe("runsOnText", () => {
  it("names the card and the API when the GPU is in use", () => {
    expect(runsOnText(gpu())).toBe("Runs on the GPU — NVIDIA GeForce RTX 4070 (CUDA).");
    expect(runsOnText(gpu({ backend: "metal", device: "Apple M2 Pro", installedBuild: "system" }))).toBe("Runs on the GPU — Apple M2 Pro (Metal).");
  });

  it("says the CPU when the switch is off, the build is the CPU one, or the GPU build found no GPU", () => {
    expect(runsOnText(gpu({ useGpu: false }))).toBe("GPU turned off — runs on the CPU.");
    expect(runsOnText(gpu({ installedBuild: "cpu", backend: "none", device: null }))).toBe("Runs on the CPU.");
    expect(runsOnText(gpu({ backend: "none", device: null }))).toContain("found no GPU it can use");
  });

  it("says it is checking while the probe runs", () => {
    expect(runsOnText(gpu({ backend: null, probing: true }))).toContain("Checking");
  });
});

let view: Mounted | null = null;
let post: ReturnType<typeof spyOn>;
beforeEach(() => {
  post = spyOn(api, "post").mockImplementation(((_p: string, body: { useGpu?: boolean }) =>
    Promise.resolve(status(gpu({ useGpu: body?.useGpu ?? true })))) as never);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  post.mockRestore();
});

describe("WhisperBuildChoice", () => {
  it("offers both builds with their sizes when the host has a card that can load the GPU one", async () => {
    let picked: string | null = null;
    view = await mount(<WhisperBuildChoice gpu={gpu({ installedBuild: null })} cpuBytes={8_573_270} value="cuda" onChange={(b) => { picked = b; }} />);
    const text = view.container.textContent ?? "";
    expect(text).toContain("9 MB");
    expect(text).toContain("675 MB");
    expect(text).toContain("NVIDIA GeForce RTX 4070");
    await click(view.container.querySelector("button[aria-pressed='false']"));
    expect(picked).toBe("cpu");
  });

  it("shows nothing without such a card, on the CPU build", async () => {
    view = await mount(<WhisperBuildChoice gpu={gpu({ cudaBuild: null, installedBuild: "cpu" })} cpuBytes={8_573_270} value="cpu" onChange={() => {}} />);
    expect(view.container.textContent).toBe("");
  });
});

describe("WhisperGpuPanel", () => {
  it("turns the GPU off through the server and shows what it answers", async () => {
    let shown: SpeechStatus | null = null;
    view = await mount(<WhisperGpuPanel status={status(gpu())} onStatus={(s) => { shown = s; }} />);
    expect(view.container.textContent).toContain("Use GPU");
    await click(view.container.querySelector("button[role='switch']"));
    const { act } = await import("react");
    await act(async () => { await Promise.resolve(); });
    expect(post.mock.calls[0]).toEqual(["/api/speech/gpu", { useGpu: false }]);
    expect(shown!.gpu!.useGpu).toBe(false);
  });

  it("tells the user when a GPU run failed and went to the CPU", async () => {
    view = await mount(<WhisperGpuPanel status={status(gpu({ lastFailure: { at: "2026-11-24T08:10:00Z", message: "CUDA error: out of memory" } }))} onStatus={() => {}} />);
    expect(view.container.textContent).toContain("CUDA error: out of memory");
    expect(view.container.textContent).toContain("transcribed on the CPU instead");
  });

  it("has no switch for a build that runs on the CPU, and suggests the GPU build when the card allows it", async () => {
    view = await mount(<WhisperGpuPanel status={status(gpu({ installedBuild: "cpu", backend: "none", device: null }))} onStatus={() => {}} />);
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("Use GPU");
    expect(text).toContain("Choose the GPU build below");
  });
});

describe("WhisperBuildChoice with the CUDA build installed and no card answering", () => {
  it("still offers the way back to the CPU build", async () => {
    view = await mount(<WhisperBuildChoice gpu={gpu({ cudaBuild: null, nvidia: null })} cpuBytes={8_573_270} value="cuda" onChange={() => {}} />);
    const text = view.container.textContent ?? "";
    expect(text).toContain("CPU");
    expect(text).toContain("no NVIDIA card that can use it answers right now");
  });
});
