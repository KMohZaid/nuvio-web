export type ParsedContentRange = {
  start: number;
  end: number;
  total: number | null;
};

/** Strictly parses the byte range returned by a media host. */
export function parseContentRange(value: string | null): ParsedContentRange | null {
  // A few CDNs use `bytes=0-1/…` or add whitespace around separators even
  // though RFC 9110's canonical form is `bytes 0-1/…`.
  const match = value
    ?.trim()
    .match(/^bytes(?:\s+|=)\s*(\d+)\s*-\s*(\d+)\s*\/\s*(\d+|\*)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    (total != null && (!Number.isSafeInteger(total) || total <= end))
  )
    return null;
  return { start, end, total };
}

/**
 * `Content-Range` is not a CORS-safelisted response header. A perfectly valid
 * cross-origin 206 is therefore often visible to JavaScript with that header
 * hidden. In that one case the status and our requested offset are the only
 * information available, so accept the response and let the Matroska parser
 * detect corrupt/out-of-order bytes. If the host does expose a header, keep
 * validating its start strictly.
 */
export function partialResponseMatches(
  status: number,
  contentRange: string | null,
  expectedStart: number,
) {
  if (status !== 206) return false;
  if (contentRange == null) return true;
  return parseContentRange(contentRange)?.start === expectedStart;
}

/**
 * A retained HTTP 200 response is a live stream, even when it also supplied a
 * Content-Length. Fetch exposes decoded response bytes, while Content-Length
 * describes the encoded HTTP message and can also be rewritten by a proxy.
 * The reader's `done` flag is therefore the only trustworthy EOF signal in
 * sequential mode.
 */
export function reachedDeclaredRangeEnd(
  nextByte: number,
  totalBytes: number | null,
  readingSequentialResponse: boolean,
) {
  return (
    !readingSequentialResponse &&
    totalBytes != null &&
    nextByte >= totalBytes
  );
}
