/**
 * Human names for ffmpeg's H.264 encoders, for the codec picker.
 *
 * The wire values are ffmpeg's own encoder names, because that is what the host probes and
 * spawns — but `h264_qsv` says nothing to anyone who has not read the capture code, and the
 * choice a user is actually making is "the GPU or the CPU". Unknown names are shown verbatim
 * rather than hidden: a newer ffmpeg gaining an encoder should add a row here, and until it
 * does the picker must still be able to name what the host is running.
 */
const CODEC_LABELS: Record<string, string> = {
  h264_nvenc: "NVIDIA NVENC",
  h264_qsv: "Intel QuickSync",
  h264_vaapi: "VAAPI (GPU)",
  h264_amf: "AMD AMF",
  h264_videotoolbox: "Apple VideoToolbox",
  libx264: "Software (x264)",
};

export function codecLabel(encoder: string): string {
  return Object.hasOwn(CODEC_LABELS, encoder) ? CODEC_LABELS[encoder]! : encoder;
}

/** Whether this encoder runs on the GPU — the part that matters for "why is my CPU at 100%".
 *  Everything except libx264 is hardware; the list is the encoders, not a name pattern, so a
 *  future software encoder cannot be mislabelled by matching `h264_*`. */
export function isHardwareCodec(encoder: string): boolean {
  return encoder !== "libx264" && Object.hasOwn(CODEC_LABELS, encoder);
}
