/**
 * What "install Whisper" downloads: one whisper.cpp build per platform, one
 * speech model, and the VAD model that goes with every model.
 *
 * Pure and parameterised so the whole matrix is unit-testable without touching
 * `process.*` or the network. Every entry is pinned by tag/revision AND by
 * SHA-256, because this code downloads an executable onto the user's machine.
 *
 * The VAD model is not optional. Whisper invents speech out of silence, and in
 * Vietnamese it invents the same YouTube outro every time — six seconds of
 * digital silence transcribed as "Hãy subscribe cho kênh Ghiền Mì Gõ Để không
 * bỏ lỡ những video hấp dẫn" on both `small` and `large-v3-turbo`, and pink
 * noise as "Cảm ơn các bạn đã theo dõi và hẹn gặp lại." With Silero VAD in
 * front, both come back empty (and in 0.3s instead of seconds).
 */

/** whisper.cpp release that the prebuilt binaries come from. */
export const WHISPER_BUILD = "b5130";
/** Whisper version inside that build, for display only. */
export const WHISPER_VERSION = "1.9.4";

const RELEASE_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_BUILD}`;

/** Pinned commits of the Hugging Face repos the models are fetched from. */
const MODEL_REPO_REV = "5359861c739e955e79d9a303bcbc70fb988958b1";
const VAD_REPO_REV = "9ffd54a1e1ee413ddf265af9913beaf518d1639b";

export interface WhisperAsset {
  /** Archive file name as published in the release. */
  file: string;
  url: string;
  sha256: string;
  ext: "tar.gz" | "zip";
}

/**
 * Prebuilt whisper.cpp per platform.
 *
 * macOS is deliberately absent: the release ships an xcframework (a library for
 * Swift apps), never a `whisper-cli`, so there is nothing to download and
 * unpack. A Mac uses Homebrew's `whisper.cpp` formula instead — see
 * `MACOS_INSTALL_HINT` — and PPM then finds `whisper-cli` on PATH.
 */
const ASSETS: Record<string, WhisperAsset> = {
  "linux-x64": {
    file: "whisper-bin-ubuntu-x64.tar.gz",
    url: `${RELEASE_BASE}/whisper-bin-ubuntu-x64.tar.gz`,
    sha256: "53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32",
    ext: "tar.gz",
  },
  "linux-arm64": {
    file: "whisper-bin-ubuntu-arm64.tar.gz",
    url: `${RELEASE_BASE}/whisper-bin-ubuntu-arm64.tar.gz`,
    sha256: "93532a0e3777f26f041ffa358ee77dd88b1a33a86847c1990745327ff335a5d6",
    ext: "tar.gz",
  },
  "win32-x64": {
    file: "whisper-bin-x64.zip",
    url: `${RELEASE_BASE}/whisper-bin-x64.zip`,
    sha256: "f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c",
    ext: "zip",
  },
  "win32-arm64": {
    file: "whisper-bin-win-cpu-arm64.zip",
    url: `${RELEASE_BASE}/whisper-bin-win-cpu-arm64.zip`,
    sha256: "799543b926ab5b6c2d60cab269a2092e0ae8d27820e9e15429e59de3699546fc",
    ext: "zip",
  },
};

export const MACOS_INSTALL_HINT = "brew install whisper.cpp";

/** The published build for a platform/arch pair, or null when there is none. */
export function whisperAssetFor(platform: NodeJS.Platform, arch: string): WhisperAsset | null {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

export interface WhisperModel {
  id: string;
  /** File name in the Hugging Face repo, and on disk. */
  file: string;
  label: string;
  /** One line under the label in Settings. */
  note: string;
  bytes: number;
  sha256: string;
}

/**
 * Three rungs, measured on a 10s Vietnamese clip (i9-12900K, 16 threads):
 * `base` 0.9s but "sửa giúp" came back "sửa dụp"; `small` 2.2s and readable;
 * `large-v3-turbo` 5.5s and the only one that kept English identifiers
 * ("handle ... toggle ... message input") intact. Quantized weights, since a
 * q5 file is a third of the size for no accuracy difference anyone dictating a
 * chat message would notice.
 */
export const WHISPER_MODELS: WhisperModel[] = [
  {
    id: "base-q5_1",
    file: "ggml-base-q5_1.bin",
    label: "Base",
    note: "Fastest, weakest — usable for English, rough in Vietnamese",
    bytes: 59_707_625,
    sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
  },
  {
    id: "small-q5_1",
    file: "ggml-small-q5_1.bin",
    label: "Small",
    note: "Middle ground — readable Vietnamese, garbles English words",
    bytes: 190_085_487,
    sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  },
  {
    id: "large-v3-turbo-q5_0",
    file: "ggml-large-v3-turbo-q5_0.bin",
    label: "Large v3 Turbo",
    note: "Best Vietnamese, keeps English terms — a few seconds per sentence",
    bytes: 574_041_195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  },
];

export const DEFAULT_MODEL_ID = "large-v3-turbo-q5_0";

export const VAD_MODEL = {
  file: "ggml-silero-v5.1.2.bin",
  bytes: 885_098,
  sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
};

export function modelById(id: string): WhisperModel | null {
  return WHISPER_MODELS.find((m) => m.id === id) ?? null;
}

export function modelUrl(model: WhisperModel): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REPO_REV}/${model.file}`;
}

export function vadModelUrl(): string {
  return `https://huggingface.co/ggml-org/whisper-vad/resolve/${VAD_REPO_REV}/${VAD_MODEL.file}`;
}
