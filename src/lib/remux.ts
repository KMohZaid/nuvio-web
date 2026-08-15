import { buildInitSegment, buildMediaSegment, type MuxTrack, type MuxSample } from "./fmp4";
import type { BlockScan, TrackHeader } from "./matroskaBlocks";

/**
 * Turns a Matroska scan into fMP4 segments.
 *
 * Deliberately separate from the writer: this is where Matroska's conventions
 * are translated, and the writer stays a plain box builder that knows nothing
 * about where its inputs came from.
 */

/** Matroska codec ids map onto MP4 sample entries, but not one-for-one. */
export function sampleEntryFor(codecId: string): string | null {
  const id = codecId.toUpperCase();
  if (id.startsWith("V_AV1")) return "av01";
  if (id.startsWith("V_MPEG4/ISO/AVC")) return "avc1";
  if (id.startsWith("V_MPEGH/ISO/HEVC")) return "hvc1";
  if (id.startsWith("A_AAC")) return "mp4a";
  return null;
}

export type RemuxError = { track: TrackHeader; reason: string };

export function describeTrack(
  track: TrackHeader,
  width?: number,
  height?: number,
  channels?: number,
): MuxTrack | RemuxError {
  const entry = sampleEntryFor(track.codecId);
  if (!entry)
    return { track, reason: `${track.codecId} has no MP4 sample entry here.` };
  if (!track.codecPrivate?.length)
    return {
      track,
      // E-AC-3 and AC-3 land here: Matroska stores no config and MP4 needs a
      // dec3/dac3 box synthesised from the bitstream, which is separate work.
      reason: `${track.codecId} carries no CodecPrivate, so its decoder config would have to be synthesised.`,
    };
  return {
    id: track.number,
    kind: entry === "mp4a" ? "audio" : "video",
    sampleEntry: entry,
    config: track.codecPrivate,
    // Milliseconds: the scan already scaled timestamps into them.
    timescale: 1000,
    width,
    height,
    channels,
  };
}

/**
 * Builds the samples for one track.
 *
 * Durations come from the gap to the next frame, because Matroska stores when
 * a frame starts and MP4 stores how long it lasts. The final frame has no
 * successor, so it inherits the previous gap.
 */
export function samplesFor(
  scan: BlockScan,
  buffer: Uint8Array,
  trackNumber: number,
): MuxSample[] {
  const frames = scan.frames
    .filter((frame) => frame.track === trackNumber)
    .sort((left, right) => left.timeMs - right.timeMs);
  return frames.map((frame, index) => {
    const next = frames[index + 1];
    const previous = frames[index - 1];
    const duration = next
      ? next.timeMs - frame.timeMs
      : previous
        ? frame.timeMs - previous.timeMs
        : 40;
    return {
      data: buffer.subarray(frame.offset, frame.offset + frame.size),
      durationTicks: Math.max(1, Math.round(duration)),
      keyframe: frame.keyframe,
    };
  });
}

export function buildSegments(
  scan: BlockScan,
  buffer: Uint8Array,
  track: MuxTrack,
): { init: Uint8Array; media: Uint8Array; sampleCount: number } {
  const samples = samplesFor(scan, buffer, track.id);
  const first = scan.frames
    .filter((frame) => frame.track === track.id)
    .reduce((lowest, frame) => Math.min(lowest, frame.timeMs), Infinity);
  return {
    init: buildInitSegment([track]),
    media: buildMediaSegment(1, track.id, Number.isFinite(first) ? Math.round(first) : 0, samples),
    sampleCount: samples.length,
  };
}
