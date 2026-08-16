/**
 * ManagedMediaSource owns normal memory cleanup. Explicitly trimming it every
 * few hundred milliseconds fights WebKit's active cleanup and can remove the
 * range iOS is about to decode. A real quota failure is the one exception: at
 * that point a best-effort manual trim is preferable to a permanently blocked
 * append.
 */
export function shouldManuallyEvict(
  managedMediaSource: boolean,
  overBudget: boolean,
  quotaRecovery = false,
) {
  return quotaRecovery || (!managedMediaSource && overBudget);
}

/**
 * `endstreaming` is WebKit asking the producer to stop feeding MMS. Keep one
 * second as a defensive floor so a missed/delayed `startstreaming` event
 * cannot deadlock an empty player.
 */
export function shouldPauseManagedBuffering(
  managedMediaSource: boolean,
  wantsData: boolean,
  bufferedAheadSeconds: number,
) {
  return managedMediaSource && !wantsData && bufferedAheadSeconds >= 1;
}

/**
 * Demuxing can outrun SourceBuffer appends even when the visible buffered
 * range is short. Bound the already-remuxed queue separately so those fMP4
 * fragments cannot quietly consume the PWA's entire WebContent memory budget.
 */
export function shouldPauseForRemuxQueue(
  queuedBytes: number,
  queuedSegments: number,
  maxBytes: number,
  maxSegments: number,
) {
  return queuedBytes >= maxBytes || queuedSegments >= maxSegments;
}

/**
 * A flat public buffered range is not evidence of a failed append while an
 * asynchronous SourceBuffer update (or an already-remuxed queue) is still in
 * flight. Only report the no-progress watchdog once both paths are idle.
 */
export function shouldReportNoAppendProgress(
  bytesSinceProgress: number,
  bufferUpdating: boolean,
  queuedSegments: number,
  thresholdBytes = 48 * 1024 * 1024,
) {
  return (
    bytesSinceProgress > thresholdBytes &&
    !bufferUpdating &&
    queuedSegments === 0
  );
}
