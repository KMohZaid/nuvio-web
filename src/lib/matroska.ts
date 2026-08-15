/**
 * Minimal Matroska probe.
 *
 * Reads enough of the front of a file to answer the only question that decides
 * whether client-side remuxing is worth building: what codecs are in here, and
 * can this browser decode them once they are re-boxed into fMP4?
 *
 * Remuxing never changes a codec. A file is playable after remux only if the
 * browser already has a decoder for each stream — which is why the audio
 * track, not the container, is usually what rules a file out.
 */

const ID_SEGMENT = 0x18538067;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_TRACK_NAME = 0x536e;
const ID_LANGUAGE = 0x22b59c;
const ID_VIDEO = 0xe0;
const ID_AUDIO = 0xe1;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;
const ID_CHANNELS = 0x9f;

export type MatroskaTrack = {
  kind: "video" | "audio" | "subtitle" | "other";
  codecId: string;
  name?: string;
  language?: string;
  width?: number;
  height?: number;
  channels?: number;
};

type Cursor = { view: DataView; offset: number };

/** EBML element ids keep their length marker; sizes strip theirs. */
function readVint(cursor: Cursor, keepMarker: boolean): number | null {
  const { view } = cursor;
  if (cursor.offset >= view.byteLength) return null;
  const first = view.getUint8(cursor.offset);
  if (first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  if (length > 8 || cursor.offset + length > view.byteLength) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  for (let index = 1; index < length; index += 1)
    value = value * 256 + view.getUint8(cursor.offset + index);
  cursor.offset += length;
  return value;
}

const readUint = (view: DataView, start: number, size: number) => {
  let value = 0;
  for (let index = 0; index < size; index += 1)
    value = value * 256 + view.getUint8(start + index);
  return value;
};

const readString = (view: DataView, start: number, size: number) =>
  new TextDecoder()
    .decode(new Uint8Array(view.buffer, view.byteOffset + start, size))
    .replace(/\0+$/, "");

function parseTrackEntry(view: DataView, start: number, end: number) {
  const track: MatroskaTrack = { kind: "other", codecId: "" };
  const cursor: Cursor = { view, offset: start };
  while (cursor.offset < end) {
    const previous = cursor.offset;
    const id = readVint(cursor, true);
    const size = readVint(cursor, false);
    if (id == null || size == null) break;
    const body = cursor.offset;
    if (body + size > end) break;
    if (id === ID_TRACK_TYPE) {
      const type = readUint(view, body, size);
      track.kind =
        type === 1
          ? "video"
          : type === 2
            ? "audio"
            : type === 17
              ? "subtitle"
              : "other";
    } else if (id === ID_CODEC_ID) {
      track.codecId = readString(view, body, size);
    } else if (id === ID_TRACK_NAME) {
      track.name = readString(view, body, size);
    } else if (id === ID_LANGUAGE) {
      track.language = readString(view, body, size);
    } else if (id === ID_VIDEO || id === ID_AUDIO) {
      // Nested element: walk its children for dimensions and channel count.
      const inner: Cursor = { view, offset: body };
      while (inner.offset < body + size) {
        const innerPrevious = inner.offset;
        const innerId = readVint(inner, true);
        const innerSize = readVint(inner, false);
        if (innerId == null || innerSize == null) break;
        const innerBody = inner.offset;
        if (innerId === ID_PIXEL_WIDTH)
          track.width = readUint(view, innerBody, innerSize);
        else if (innerId === ID_PIXEL_HEIGHT)
          track.height = readUint(view, innerBody, innerSize);
        else if (innerId === ID_CHANNELS)
          track.channels = readUint(view, innerBody, innerSize);
        inner.offset = innerBody + innerSize;
        if (inner.offset <= innerPrevious) break;
      }
    }
    cursor.offset = body + size;
    // A malformed element that consumes nothing would loop forever, and a
    // blocked main thread on iOS is killed — indistinguishable from a crash.
    if (cursor.offset <= previous) break;
  }
  return track;
}

/** Walks a range of elements looking for Tracks, descending into Segment. */
function findTracks(
  view: DataView,
  start: number,
  end: number,
): MatroskaTrack[] | null {
  const cursor: Cursor = { view, offset: start };
  while (cursor.offset < end) {
    const previous = cursor.offset;
    const id = readVint(cursor, true);
    const size = readVint(cursor, false);
    if (id == null || size == null) return null;
    const body = cursor.offset;
    // Segment almost always declares an unknown size, so treat it as running
    // to the end of what was fetched rather than trusting the declared length.
    if (id === ID_SEGMENT) return findTracks(view, body, end);
    if (id === ID_TRACKS) {
      const limit = Math.min(body + size, end);
      const tracks: MatroskaTrack[] = [];
      const inner: Cursor = { view, offset: body };
      while (inner.offset < limit) {
        const entryPrevious = inner.offset;
        const entryId = readVint(inner, true);
        const entrySize = readVint(inner, false);
        if (entryId == null || entrySize == null) break;
        const entryBody = inner.offset;
        if (entryId === ID_TRACK_ENTRY)
          tracks.push(
            parseTrackEntry(
              view,
              entryBody,
              Math.min(entryBody + entrySize, limit),
            ),
          );
        inner.offset = entryBody + entrySize;
        if (inner.offset <= entryPrevious) break;
      }
      return tracks;
    }
    if (size <= 0 || body + size > end) return null;
    cursor.offset = body + size;
    if (cursor.offset <= previous) return null;
  }
  return null;
}

export type ProbeResult = {
  /** Kept so a block scan can run over the same bytes without refetching. */
  buffer: Uint8Array;
  bytesRead: number;
  acceptsRanges: boolean;
  totalBytes: number | null;
  tracks: MatroskaTrack[];
  /** Set when the request was redirected — the usual reason Range is lost,
   *  since debrid links bounce to a storage node that may not forward it. */
  redirected: boolean;
  finalUrl: string;
  status: number;
  acceptRangesHeader: string | null;
};

/**
 * Tracks usually sit within the first megabyte, after SeekHead and Info. If
 * they do not, the file needs SeekHead resolution to locate them — worth
 * knowing early, since that is the difference between a simple probe and a
 * real parser.
 */
export async function probeMatroska(
  url: string,
  bytes = 2 * 1024 * 1024,
): Promise<ProbeResult> {
  // 20s ceiling: a debrid host that stalls should fail, not hang the page.
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 20_000);
  try {
    let response = await fetch(url, {
      headers: { Range: `bytes=0-${bytes - 1}` },
      signal: controller.signal,
      // The service worker has no business touching a multi-gigabyte media
      // request, and on iOS its handling of Range is not dependable.
      cache: "no-store",
    });
    // A debrid link bounces to a storage node, and the Range header does not
    // always survive the hop — the first request comes back 200 with the whole
    // file. Retrying against the resolved URL gets a proper 206, so resolve
    // once and stream from there.
    if (response.status !== 206 && response.redirected) {
      const resolved = await fetch(response.url, {
        headers: { Range: `bytes=0-${bytes - 1}` },
        signal: controller.signal,
        cache: "no-store",
      });
      if (resolved.status === 206) {
        await response.body?.cancel().catch(() => undefined);
        response = resolved;
      }
    }
    if (!response.ok && response.status !== 206)
      throw new Error(`Server refused the range request (${response.status}).`);

    // Read incrementally and stop at the cap rather than calling
    // arrayBuffer(). A host that ignores Range answers 200 with the whole
    // file, and buffering that is an instant out-of-memory kill on a phone —
    // which reads as the app simply reloading.
    const chunks: Uint8Array[] = [];
    let read = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("This browser gave no readable stream.");
    while (read < bytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      read += value.byteLength;
    }
    // Stop the transfer; without this the rest of the file keeps downloading.
    await reader.cancel().catch(() => undefined);

    const buffer = new Uint8Array(Math.min(read, bytes));
    let offset = 0;
    for (const chunk of chunks) {
      if (offset >= buffer.byteLength) break;
      buffer.set(chunk.subarray(0, buffer.byteLength - offset), offset);
      offset += chunk.byteLength;
    }
    const contentRange = response.headers.get("content-range");
    const total = contentRange?.split("/")?.[1];
    const view = new DataView(buffer.buffer, 0, buffer.byteLength);
    return {
      buffer,
      bytesRead: buffer.byteLength,
      acceptsRanges: response.status === 206,
      totalBytes: total && total !== "*" ? Number(total) : null,
      tracks: findTracks(view, 0, buffer.byteLength) ?? [],
      redirected: response.redirected,
      finalUrl: response.url,
      status: response.status,
      acceptRangesHeader: response.headers.get("accept-ranges"),
    };
  } finally {
    window.clearTimeout(timer);
  }
}

/** What a codec means for a remux-only pipeline in this browser. */
export type CodecVerdict = {
  label: string;
  status: "ok" | "transcode" | "blocked";
  detail: string;
};

const canPlay = (type: string) =>
  document.createElement("video").canPlayType(type) !== "";

export function verdictFor(track: MatroskaTrack): CodecVerdict {
  const id = track.codecId.toUpperCase();

  if (track.kind === "video") {
    if (id.startsWith("V_MPEG4/ISO/AVC"))
      return { label: "H.264", status: "ok", detail: "Remuxes to fMP4." };
    if (id.startsWith("V_MPEGH/ISO/HEVC"))
      return canPlay('video/mp4; codecs="hvc1.1.6.L93.B0"')
        ? { label: "HEVC", status: "ok", detail: "Hardware decoded here." }
        : {
            label: "HEVC",
            status: "blocked",
            detail: "This browser has no HEVC decoder.",
          };
    if (id.startsWith("V_AV1"))
      return canPlay('video/mp4; codecs="av01.0.05M.08"')
        ? { label: "AV1", status: "ok", detail: "Decoder present." }
        : { label: "AV1", status: "blocked", detail: "No AV1 decoder." };
    return {
      label: id || "video",
      status: "blocked",
      detail: "Unrecognised video codec.",
    };
  }

  if (track.kind === "audio") {
    if (id.startsWith("A_AAC"))
      return { label: "AAC", status: "ok", detail: "Remuxes cleanly." };
    if (id.startsWith("A_AC3"))
      return canPlay('audio/mp4; codecs="ac-3"')
        ? { label: "AC-3", status: "ok", detail: "Decoded on Apple platforms." }
        : {
            label: "AC-3",
            status: "transcode",
            detail: "No decoder here, so audio needs transcoding to AAC.",
          };
    if (id.startsWith("A_EAC3"))
      return canPlay('audio/mp4; codecs="ec-3"')
        ? {
            label: "E-AC-3",
            status: "ok",
            detail: "Decoded on Apple platforms.",
          }
        : {
            label: "E-AC-3",
            status: "transcode",
            detail: "No decoder here, so audio needs transcoding to AAC.",
          };
    if (id.startsWith("A_TRUEHD"))
      return {
        label: "TrueHD",
        status: "transcode",
        detail: "No browser decodes TrueHD. Audio must be transcoded.",
      };
    if (id.startsWith("A_DTS"))
      return {
        label: "DTS",
        status: "transcode",
        detail: "No browser decodes DTS. Audio must be transcoded.",
      };
    if (id.startsWith("A_OPUS"))
      return { label: "Opus", status: "ok", detail: "Remuxes to fMP4." };
    if (id.startsWith("A_FLAC"))
      return {
        label: "FLAC",
        status: "transcode",
        detail: "Rarely playable inside fMP4.",
      };
    return {
      label: id || "audio",
      status: "transcode",
      detail: "Unrecognised audio codec.",
    };
  }

  return {
    label: id || track.kind,
    status: "ok",
    detail: "Not needed for playback.",
  };
}

/** True when MSE is usable at all — on iPhone this arrived in Safari 17. */
export function mediaSourceSupport(): string {
  const managed = "ManagedMediaSource" in window;
  const plain = "MediaSource" in window;
  if (managed) return "ManagedMediaSource (iOS 17+ / Safari 17+)";
  if (plain) return "MediaSource";
  return "none — remuxing cannot work in this browser";
}

export type RemuxPlan = {
  video?: MatroskaTrack;
  audio?: MatroskaTrack;
  /** Text subtitles convertible to WebVTT. Bitmap ones are dropped. */
  subtitles: MatroskaTrack[];
  needsAudioTranscode: boolean;
  droppedBitmapSubtitles: number;
  summary: string;
};

/**
 * Chooses which streams a remuxer would actually carry.
 *
 * The important part is that a file with an undecodable default audio track is
 * not necessarily a problem: releases routinely ship TrueHD alongside E-AC-3,
 * and picking the playable one avoids transcoding altogether. Preferring the
 * first track — which is what a naive remuxer does — would land on TrueHD and
 * force a WASM decoder that was never needed.
 */
export function planRemux(tracks: MatroskaTrack[]): RemuxPlan {
  const playable = (track: MatroskaTrack) => verdictFor(track).status === "ok";
  const video = tracks.filter((track) => track.kind === "video");
  const audio = tracks.filter((track) => track.kind === "audio");
  const subtitles = tracks.filter((track) => track.kind === "subtitle");

  // Among decodable audio, more channels is the better track.
  const chosenAudio =
    audio
      .filter(playable)
      .sort((left, right) => (right.channels ?? 0) - (left.channels ?? 0))[0] ??
    audio[0];
  const chosenVideo = video.find(playable) ?? video[0];
  const text = subtitles.filter((track) =>
    track.codecId.toUpperCase().startsWith("S_TEXT"),
  );

  const needsAudioTranscode = !!chosenAudio && !playable(chosenAudio);
  const parts: string[] = [];
  if (!chosenVideo) parts.push("no video track");
  else if (!playable(chosenVideo))
    parts.push(`${verdictFor(chosenVideo).label} video cannot be decoded here`);
  if (!chosenAudio) parts.push("no audio track");
  else if (needsAudioTranscode)
    parts.push(`${verdictFor(chosenAudio).label} audio would need transcoding`);

  return {
    video: chosenVideo,
    audio: chosenAudio,
    subtitles: text,
    needsAudioTranscode,
    droppedBitmapSubtitles: subtitles.length - text.length,
    summary: parts.length
      ? parts.join("; ")
      : "Remux only — every chosen stream decodes here as-is.",
  };
}
