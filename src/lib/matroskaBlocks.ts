/**
 * Reads actual frames out of a Matroska stream.
 *
 * The probe answered "what is in this file". This answers the harder question
 * a remuxer depends on: can we locate individual encoded frames, with correct
 * timestamps and keyframe flags, from a byte range in the middle of nowhere?
 *
 * Everything a muxer needs comes from here — the codec private data that
 * becomes the decoder configuration, and per-frame timestamps that become
 * sample tables. If this is wrong the output plays as garbage rather than
 * failing loudly, so it is worth verifying on its own.
 */

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_DEFAULT_DURATION = 0x23e383;
const ID_CLUSTER = 0x1f43b675;
const ID_CLUSTER_TIMESTAMP = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;

export type TrackHeader = {
  number: number;
  kind: "video" | "audio" | "subtitle" | "other";
  codecId: string;
  /** Becomes the decoder configuration in the output. */
  codecPrivate: Uint8Array | null;
  defaultDurationNs: number | null;
};

export type Frame = {
  track: number;
  /** Milliseconds, already scaled by TimestampScale. */
  timeMs: number;
  keyframe: boolean;
  size: number;
  /** Where the payload starts in the scanned buffer, for the muxer to slice. */
  offset: number;
};

export type BlockScan = {
  timestampScaleNs: number;
  durationSeconds: number | null;
  tracks: TrackHeader[];
  frames: Frame[];
  clusters: number;
  /** Set when the scan stopped because the buffer ran out mid-element. */
  truncated: boolean;
};

type Cursor = { view: DataView; offset: number };

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

/** An all-ones VINT_DATA means "size unknown" — legal for Segment and Cluster. */
const isUnknownSize = (size: number) => size >= Number.MAX_SAFE_INTEGER / 2;

const readUint = (view: DataView, start: number, size: number) => {
  let value = 0;
  for (let index = 0; index < size; index += 1)
    value = value * 256 + view.getUint8(start + index);
  return value;
};

function readFloat(view: DataView, start: number, size: number) {
  if (size === 4) return view.getFloat32(start);
  if (size === 8) return view.getFloat64(start);
  return null;
}

const readString = (view: DataView, start: number, size: number) =>
  new TextDecoder()
    .decode(new Uint8Array(view.buffer, view.byteOffset + start, size))
    .replace(/\0+$/, "");

function parseTrackEntry(view: DataView, start: number, end: number) {
  const track: TrackHeader = {
    number: 0,
    kind: "other",
    codecId: "",
    codecPrivate: null,
    defaultDurationNs: null,
  };
  const cursor: Cursor = { view, offset: start };
  while (cursor.offset < end) {
    const previous = cursor.offset;
    const id = readVint(cursor, true);
    const size = readVint(cursor, false);
    if (id == null || size == null) break;
    const body = cursor.offset;
    if (body + size > end) break;
    if (id === ID_TRACK_NUMBER) track.number = readUint(view, body, size);
    else if (id === ID_TRACK_TYPE) {
      const type = readUint(view, body, size);
      track.kind =
        type === 1
          ? "video"
          : type === 2
            ? "audio"
            : type === 17
              ? "subtitle"
              : "other";
    } else if (id === ID_CODEC_ID) track.codecId = readString(view, body, size);
    else if (id === ID_CODEC_PRIVATE)
      // Copied, not referenced: the scan buffer is discarded afterwards.
      track.codecPrivate = new Uint8Array(
        view.buffer.slice(view.byteOffset + body, view.byteOffset + body + size),
      );
    else if (id === ID_DEFAULT_DURATION)
      track.defaultDurationNs = readUint(view, body, size);
    cursor.offset = body + size;
    if (cursor.offset <= previous) break;
  }
  return track;
}

/**
 * A SimpleBlock opens with the track number as a VINT, a signed 16-bit
 * timecode relative to its cluster, then flags whose top bit marks a keyframe.
 */
function readBlockHeader(view: DataView, start: number) {
  const cursor: Cursor = { view, offset: start };
  const track = readVint(cursor, false);
  if (track == null || cursor.offset + 3 > view.byteLength) return null;
  const relative = view.getInt16(cursor.offset);
  const flags = view.getUint8(cursor.offset + 2);
  return { track, relative, flags, headerEnd: cursor.offset + 3 };
}

export function scanBlocks(buffer: Uint8Array, frameLimit = 20_000): BlockScan {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const scan: BlockScan = {
    timestampScaleNs: 1_000_000,
    durationSeconds: null,
    tracks: [],
    frames: [],
    clusters: 0,
    truncated: false,
  };

  const walk = (start: number, end: number, insideCluster: number | null) => {
    const cursor: Cursor = { view, offset: start };
    while (cursor.offset < end && scan.frames.length < frameLimit) {
      const previous = cursor.offset;
      const id = readVint(cursor, true);
      const size = readVint(cursor, false);
      if (id == null || size == null) {
        scan.truncated = true;
        return;
      }
      const body = cursor.offset;
      // Segment and Cluster may declare an unknown size; walk to the buffer end.
      const limit = isUnknownSize(size) ? end : Math.min(body + size, end);
      if (!isUnknownSize(size) && body + size > end) scan.truncated = true;

      if (id === ID_SEGMENT) {
        walk(body, end, null);
        return;
      }
      if (id === ID_INFO) {
        const inner: Cursor = { view, offset: body };
        while (inner.offset < limit) {
          const innerPrevious = inner.offset;
          const innerId = readVint(inner, true);
          const innerSize = readVint(inner, false);
          if (innerId == null || innerSize == null) break;
          const innerBody = inner.offset;
          if (innerId === ID_TIMESTAMP_SCALE)
            scan.timestampScaleNs = readUint(view, innerBody, innerSize);
          else if (innerId === ID_DURATION) {
            const raw = readFloat(view, innerBody, innerSize);
            if (raw != null)
              scan.durationSeconds = (raw * scan.timestampScaleNs) / 1e9;
          }
          inner.offset = innerBody + innerSize;
          if (inner.offset <= innerPrevious) break;
        }
      } else if (id === ID_TRACKS) {
        const inner: Cursor = { view, offset: body };
        while (inner.offset < limit) {
          const innerPrevious = inner.offset;
          const entryId = readVint(inner, true);
          const entrySize = readVint(inner, false);
          if (entryId == null || entrySize == null) break;
          const entryBody = inner.offset;
          if (entryId === ID_TRACK_ENTRY)
            scan.tracks.push(
              parseTrackEntry(view, entryBody, Math.min(entryBody + entrySize, limit)),
            );
          inner.offset = entryBody + entrySize;
          if (inner.offset <= innerPrevious) break;
        }
      } else if (id === ID_CLUSTER) {
        scan.clusters += 1;
        walk(body, limit, 0);
      } else if (id === ID_CLUSTER_TIMESTAMP && insideCluster != null) {
        // Cluster children are walked with the cluster's base timestamp, which
        // every block inside is relative to.
        const base = readUint(view, body, size);
        walkCluster(body + size, limit, base);
        cursor.offset = limit;
        continue;
      } else if (id === ID_SIMPLE_BLOCK && insideCluster != null) {
        pushFrame(body, limit, insideCluster, true);
      } else if (id === ID_BLOCK_GROUP && insideCluster != null) {
        const inner: Cursor = { view, offset: body };
        while (inner.offset < limit) {
          const innerPrevious = inner.offset;
          const blockId = readVint(inner, true);
          const blockSize = readVint(inner, false);
          if (blockId == null || blockSize == null) break;
          const blockBody = inner.offset;
          if (blockId === ID_BLOCK)
            pushFrame(blockBody, Math.min(blockBody + blockSize, limit), insideCluster, false);
          inner.offset = blockBody + blockSize;
          if (inner.offset <= innerPrevious) break;
        }
      }

      cursor.offset = isUnknownSize(size) ? limit : body + size;
      if (cursor.offset <= previous) return;
    }
  };

  const walkCluster = (start: number, end: number, base: number) => {
    const cursor: Cursor = { view, offset: start };
    while (cursor.offset < end && scan.frames.length < frameLimit) {
      const previous = cursor.offset;
      const id = readVint(cursor, true);
      const size = readVint(cursor, false);
      if (id == null || size == null) return;
      const body = cursor.offset;
      const limit = Math.min(body + size, end);
      if (id === ID_SIMPLE_BLOCK) pushFrame(body, limit, base, true);
      else if (id === ID_BLOCK_GROUP) {
        const inner: Cursor = { view, offset: body };
        while (inner.offset < limit) {
          const innerPrevious = inner.offset;
          const blockId = readVint(inner, true);
          const blockSize = readVint(inner, false);
          if (blockId == null || blockSize == null) break;
          const blockBody = inner.offset;
          if (blockId === ID_BLOCK)
            pushFrame(blockBody, Math.min(blockBody + blockSize, limit), base, false);
          inner.offset = blockBody + blockSize;
          if (inner.offset <= innerPrevious) break;
        }
      }
      cursor.offset = body + size;
      if (cursor.offset <= previous) return;
    }
  };

  const pushFrame = (
    start: number,
    end: number,
    clusterBase: number,
    simple: boolean,
  ) => {
    const header = readBlockHeader(view, start);
    if (!header || header.headerEnd > end) return;
    scan.frames.push({
      offset: header.headerEnd,
      track: header.track,
      timeMs:
        ((clusterBase + header.relative) * scan.timestampScaleNs) / 1_000_000,
      // Only a SimpleBlock carries the keyframe flag; a Block inside a
      // BlockGroup is a keyframe when it has no ReferenceBlock, which this
      // scan does not read — so it is reported conservatively.
      keyframe: simple ? (header.flags & 0x80) !== 0 : false,
      size: end - header.headerEnd,
    });
  };

  walk(0, buffer.byteLength, null);
  return scan;
}
