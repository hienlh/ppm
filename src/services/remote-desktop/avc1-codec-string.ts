/**
 * Derive the WebCodecs `avc1.PPCCLL` codec string from a real SPS NAL rather than
 * guessing. `encoderArgs()` in `ffmpeg-capabilities.ts` sets no `-profile`/`-level`, so the
 * actual encoded profile/level is encoder-default and unknown until the bitstream exists —
 * a hardcoded guess can mismatch and make `VideoDecoder.configure()` throw or refuse.
 *
 * SPS layout (after the 1-byte NAL header at index 0): profile_idc, then the
 * constraint-flags/reserved byte, then level_idc — always the first three bytes of the
 * RBSP, unaffected by emulation-prevention bytes (those only appear deeper in the SPS).
 */
export function avc1CodecString(sps: Uint8Array): string | null {
  if (sps.length < 4) return null;
  const profileIdc = sps[1]!;
  const constraintFlags = sps[2]!;
  const levelIdc = sps[3]!;
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `avc1.${hex(profileIdc)}${hex(constraintFlags)}${hex(levelIdc)}`;
}
