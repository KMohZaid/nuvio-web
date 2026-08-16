const TARGET_FRAGMENT_MS = 2_000;
/**
 * SourceBuffer may reject one very large append even when its overall quota
 * is healthy. At high 4K bitrates a two-second GOP can exceed 50 MB, so time
 * alone is not a safe fragment boundary on iOS.
 */
const TARGET_FRAGMENT_BYTES = 4 * 1024 * 1024;

export type FragmentFrame = {
  timeMs: number;
  keyframe: boolean;
  data?: { readonly byteLength: number };
};

/**
 * Only the first emitted video fragment must be advanced to a random-access
 * point. Once playback has started, a fragment beginning mid-GOP is the
 * continuous continuation of the preceding fragment and must not be dropped.
 */
export function initialFragmentStartIndex(
  frames: FragmentFrame[],
  trackStarted: boolean,
) {
  if (trackStarted || frames[0]?.keyframe) return 0;
  return frames.findIndex((frame) => frame.keyframe);
}

/**
 * Returns the number of leading frames that form the next bounded fragment.
 *
 * Only the beginning of the stream has to be a random-access point (the
 * streamer enforces that before calling here). Later fMP4 fragments are
 * continuous decode data and may begin with a dependent sample. Requiring a
 * fresh keyframe at every boundary held an entire long GOP in memory and left
 * Safari stuck at the end of the first two-second fragment.
 */
export function fragmentCutIndex(
  frames: FragmentFrame[],
  _kind: "video" | "audio",
  final: boolean,
) {
  if (frames.length < 2) return final ? frames.length : 0;
  const start = frames[0]!.timeMs;
  let bytes = frames[0]!.data?.byteLength ?? 0;
  for (let index = 1; index < frames.length; index += 1) {
    const nextBytes = frames[index]!.data?.byteLength ?? 0;
    if (
      frames[index]!.timeMs - start >= TARGET_FRAGMENT_MS ||
      bytes + nextBytes > TARGET_FRAGMENT_BYTES
    )
      return index;
    bytes += nextBytes;
  }
  return final ? frames.length : 0;
}
