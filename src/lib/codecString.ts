/**
 * Derives RFC 6381 codec strings from decoder configuration records.
 *
 * These are not cosmetic. Safari configures its decoder from the string given
 * to addSourceBuffer, so a made-up one is a promise about the bitstream that
 * the bitstream does not keep: declaring AV1 level 4.0 (max 2048x1152) for a
 * 3840x2160 stream gets the init segment accepted and the media rejected, or
 * accepted and never decoded.
 *
 * Every parameter needed is already in the configuration record that Matroska
 * carried in CodecPrivate, so none of it has to be guessed.
 */

const hex = (value: number, digits: number) =>
  value.toString(16).toUpperCase().padStart(digits, "0");

/**
 * AV1CodecConfigurationRecord, per the AV1-in-ISOBMFF specification.
 *
 *   byte 1: seq_profile (3) | seq_level_idx_0 (5)
 *   byte 2: seq_tier_0 (1) | high_bitdepth (1) | twelve_bit (1) | monochrome (1)
 *           | chroma_subsampling_x (1) | chroma_subsampling_y (1)
 *           | chroma_sample_position (2)
 */
export function av1CodecString(config: Uint8Array): string | null {
  if (config.length < 3) return null;
  const profile = (config[1]! >> 5) & 0x07;
  const level = config[1]! & 0x1f;
  const tier = (config[2]! >> 7) & 0x01;
  const highBitdepth = (config[2]! >> 6) & 0x01;
  const twelveBit = (config[2]! >> 5) & 0x01;
  // Twelve-bit only exists in professional profile; elsewhere the high bit
  // depth flag alone separates 8 from 10.
  const depth = profile === 2 && twelveBit ? 12 : highBitdepth ? 10 : 8;
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier ? "H" : "M"}.${String(depth).padStart(2, "0")}`;
}

/**
 * AVCDecoderConfigurationRecord: the three bytes after the version are exactly
 * the profile, compatibility and level the codec string carries.
 */
export function avcCodecString(config: Uint8Array): string | null {
  if (config.length < 4) return null;
  return `avc1.${hex(config[1]!, 2)}${hex(config[2]!, 2)}${hex(config[3]!, 2)}`;
}

/**
 * HEVCDecoderConfigurationRecord, per ISO/IEC 14496-15 Annex E.
 *
 *   byte 1:      general_profile_space (2) | general_tier_flag (1)
 *                | general_profile_idc (5)
 *   bytes 2-5:   general_profile_compatibility_flags (32)
 *   bytes 6-11:  general_constraint_indicator_flags (48)
 *   byte 12:     general_level_idc
 */
export function hevcCodecString(
  config: Uint8Array,
  sampleEntry = "hvc1",
): string | null {
  if (config.length < 13) return null;
  const profileSpace = (config[1]! >> 6) & 0x03;
  const tier = (config[1]! >> 5) & 0x01;
  const profile = config[1]! & 0x1f;

  let compatibility = 0;
  for (let index = 2; index <= 5; index += 1)
    compatibility = ((compatibility << 8) | config[index]!) >>> 0;
  // The string carries these flags in reverse bit order, which is the one part
  // of this that cannot be read off the record directly.
  let reversed = 0;
  for (let bit = 0; bit < 32; bit += 1)
    if (compatibility & (1 << bit)) reversed = (reversed | (1 << (31 - bit))) >>> 0;

  // Constraint bytes are dot-separated, with trailing zero bytes omitted.
  const constraints: string[] = [];
  for (let index = 6; index <= 11; index += 1) constraints.push(hex(config[index]!, 2));
  while (constraints.length && constraints.at(-1) === "00") constraints.pop();

  const space = profileSpace === 0 ? "" : String.fromCharCode(64 + profileSpace);
  const parts = [
    sampleEntry,
    `${space}${profile}`,
    reversed.toString(16).toUpperCase(),
    `${tier ? "H" : "L"}${config[12]!}`,
    ...constraints,
  ];
  return parts.join(".");
}

/**
 * Falls back to a plausible string only when the record is too short to read,
 * which means the file gave us something malformed rather than that we chose
 * not to look.
 */
export function codecStringFor(sampleEntry: string, config: Uint8Array): string {
  switch (sampleEntry) {
    case "av01":
      return av1CodecString(config) ?? "av01.0.08M.08";
    case "avc1":
      return avcCodecString(config) ?? "avc1.640028";
    case "hvc1":
      return hevcCodecString(config) ?? "hvc1.1.6.L93.B0";
    case "ec-3":
      return "ec-3";
    case "ac-3":
      return "ac-3";
    default:
      return "mp4a.40.2";
  }
}
