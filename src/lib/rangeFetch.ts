import { partialResponseMatches } from "./httpRange.ts";

export type RangeCapability = "unknown" | "range" | "sequential";

export type RangeFetchState = {
  /** The final CDN URL discovered after the addon's playback redirect. */
  resolvedUrl: string | null;
};

function mergedRequestHeaders(input: RequestInfo | URL, init?: RequestInit) {
  const headers =
    typeof Request !== "undefined" && input instanceof Request
      ? new Headers(input.headers)
      : new Headers();
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

async function cancelResponse(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is only a best-effort way to close the unused connection.
  }
}

export async function fetchMediaRange(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  state: RangeFetchState,
  onCapability?: (capability: RangeCapability) => void,
  fetchImpl: typeof fetch = fetch,
) {
  const headers = mergedRequestHeaders(input, init);
  const requestedRange = headers.get("Range");
  const requestedStartMatch = requestedRange?.match(/^bytes=(\d+)-/i);
  const requestedStart = requestedStartMatch
    ? Number(requestedStartMatch[1])
    : null;

  // AIOStreams-style playback URLs commonly redirect to a range-capable CDN.
  // WebKit has versions where a cross-origin redirect loses the Range header,
  // even though a direct request to response.url returns the correct 206. Once
  // the final URL is known, bypass the redirect for every later read.
  const target = state.resolvedUrl ?? input;
  let response = await fetchImpl(target, { ...init, headers });

  // A temporary CDN URL can expire during a long playback session. Re-enter
  // through the original addon URL once so it can issue a fresh redirect.
  if (
    state.resolvedUrl &&
    (response.status === 401 ||
      response.status === 403 ||
      response.status === 404)
  ) {
    await cancelResponse(response);
    state.resolvedUrl = null;
    response = await fetchImpl(input, { ...init, headers });
  }

  if (requestedStart !== null && response.redirected && response.url) {
    const redirectedUrl = response.url;
    const redirectedRangeMatches = partialResponseMatches(
      response.status,
      response.headers.get("Content-Range"),
      requestedStart,
    );

    if (redirectedRangeMatches) {
      state.resolvedUrl = redirectedUrl;
    } else {
      // Retry the final CDN directly before declaring the host sequential. This
      // specifically avoids WebKit's Range-across-redirect failure mode.
      try {
        const direct = await fetchImpl(redirectedUrl, { ...init, headers });
        if (
          partialResponseMatches(
            direct.status,
            direct.headers.get("Content-Range"),
            requestedStart,
          )
        ) {
          state.resolvedUrl = redirectedUrl;
          await cancelResponse(response);
          response = direct;
        } else {
          await cancelResponse(direct);
        }
      } catch {
        // The original response is still available for the precise error below.
      }
    }
  }

  const exposedRangeMismatch =
    requestedStart !== null &&
    response.status === 206 &&
    !partialResponseMatches(
      response.status,
      response.headers.get("Content-Range"),
      requestedStart,
    );
  if (response.status !== 416 && !exposedRangeMismatch) {
    onCapability?.(response.status === 206 ? "range" : "sequential");
    if (requestedStart === null || response.status === 206) return response;
  }

  // A bounded sequential UrlSource eventually revisits Matroska headers that
  // have already been evicted. Increasing this to Infinity would retain an
  // entire multi-gigabyte file and iOS terminates the PWA. Fail early and offer
  // external playback instead of downloading until the WebContent process dies.
  await cancelResponse(response);
  onCapability?.("sequential");
  throw new Error(
    response.status === 200
      ? "This media host ignored byte-range requests required for browser remuxing. Try another source or an external player."
      : "The media host returned an unusable byte range. Try another source or an external player.",
  );
}
