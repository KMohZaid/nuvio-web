import { buildInitSegment, buildMediaSegment, type MuxTrack, type MuxSample } from "./fmp4";
import type { BlockScan, TrackHeader } from "./matroskaBlocks";
import { buildDac3, buildDec3, parseAc3 } from "./eac3";

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
  if (id.startsWith("A_EAC3")) return "ec-3";
  if (id.startsWith("A_AC3")) return "ac-3";
  return null;
}

export type RemuxError = { track: TrackHeader; reason: string };

export function describeTrack(
  track: TrackHeader,
  width?: number,
  height?: number,
  channels?: number,
  /** First frame of this track, needed for codecs that carry no CodecPrivate. */
  firstFrame?: Uint8Array,
): MuxTrack | RemuxError {
  const entry = sampleEntryFor(track.codecId);
  if (!entry)
    return { track, reason: `${track.codecId} has no MP4 sample entry here.` };

  const dolby = entry === "ec-3" || entry === "ac-3";
  let config = track.codecPrivate;
  let rate: number | undefined;
  let channelCount = channels;

  if (dolby) {
    // Matroska stores nothing for these, so the parameters are read out of the
    // first audio frame and the box is rebuilt from them.
    if (!firstFrame?.length)
      return { track, reason: `${track.codecId} needs a frame to read its configuration from.` };
    const info = parseAc3(firstFrame);
    if (!info)
      return { track, reason: `No ${track.codecId} sync frame found to configure from.` };
    config = entry === "ec-3" ? buildDec3(info) : buildDac3(info);
    rate = info.sampleRate;
    channelCount = info.channels;
  }

  if (!config?.length)
    return {
      track,
      reason: `${track.codecId} carries no CodecPrivate and none could be synthesised.`,
    };

  return {
    id: track.number,
    kind: entry === "av01" || entry === "avc1" || entry === "hvc1" ? "video" : "audio",
    sampleEntry: entry,
    config,
    // Milliseconds: the scan already scaled timestamps into them.
    timescale: 1000,
    width,
    height,
    channels: channelCount,
    sampleRate: rate,
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
