/**
 * Resumable Matroska demuxer.
 *
 * The scanning demuxer assumes it holds the whole file. Streaming does not:
 * bytes arrive in chunks, and an element routinely straddles the boundary
 * between two of them. So this keeps a parser stack and a pending buffer,
 * consumes whatever is complete, and carries the remainder into the next
 * chunk — resuming mid-element rather than starting over.
 *
 * The other thing it has to do is *not* buffer. A Cluster can be megabytes and
 * a file can carry attachments larger still, so uninteresting elements are
 * skipped by counting bytes past rather than by holding them in memory.
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
const ID_VIDEO = 0xe0;
const ID_AUDIO = 0xe1;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;
const ID_CHANNELS = 0x9f;
const ID_SAMPLING_FREQUENCY = 0xb5;
const ID_CLUSTER = 0x1f43b675;
const ID_CLUSTER_TIMESTAMP = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_REFERENCE_BLOCK = 0xfb;

/** Descended into rather than buffered whole. */
const CONTAINERS = new Set([ID_SEGMENT, ID_CLUSTER, ID_BLOCK_GROUP]);
/** Small enough to wait for in full, and needed in one piece. */
const BUFFERED = new Set([ID_INFO, ID_TRACKS]);

export type StreamTrack = {
  number: number;
  kind: "video" | "audio" | "subtitle" | "other";
  codecId: string;
  codecPrivate: Uint8Array | null;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
};

export type StreamFrame = {
  track: number;
  timeMs: number;
  keyframe: boolean;
  data: Uint8Array;
};

type Frame = { id: number; end: number };

export class MatroskaStream {
  private pending: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  /** Absolute file offset of pending[0]. */
  private origin = 0;
  private stack: Frame[] = [];
  private skipRemaining = 0;
  private clusterTimeMs = 0;
  /**
   * A Block inside a BlockGroup cannot be classified when it is read: it is a
   * keyframe exactly when the group carries no ReferenceBlock, and that sibling
   * arrives afterwards. So the frame waits for its group to close.
   */
  private groupFrame: StreamFrame | null = null;
  private groupReferenced = false;

  timestampScaleNs = 1_000_000;
  durationSeconds: number | null = null;
  tracks: StreamTrack[] = [];
  /** Set once Tracks has been parsed, so a consumer knows configs are ready. */
  headerComplete = false;

  constructor(startOffset = 0) {
    this.origin = startOffset;
  }

  /** Feeds a chunk and returns whatever frames became complete. */
  push(chunk: Uint8Array): StreamFrame[] {
    if (this.pending.byteLength === 0)
      this.pending = chunk as Uint8Array<ArrayBuffer>;
    else {
      const merged = new Uint8Array(this.pending.byteLength + chunk.byteLength);
      merged.set(this.pending, 0);
      merged.set(chunk, this.pending.byteLength);
      this.pending = merged;
    }
    const frames: StreamFrame[] = [];
    this.drain(frames);
    return frames;
  }

  /** Bytes held while waiting for an element to complete. */
  get buffered(): number {
    return this.pending.byteLength;
  }

  private consume(count: number) {
    this.pending = this.pending.subarray(count) as Uint8Array<ArrayBuffer>;
    this.origin += count;
  }

  private view() {
    return new DataView(
      this.pending.buffer,
      this.pending.byteOffset,
      this.pending.byteLength,
    );
  }

  /**
   * Reads an element id or size at `offset`, returning null when the bytes to
   * finish it have not arrived. Ids keep their length marker; sizes strip it.
   */
  private readVint(offset: number, keepMarker: boolean) {
    if (offset >= this.pending.byteLength) return null;
    const first = this.pending[offset]!;
    if (first === 0) return null;
    let length = 1;
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
    if (length > 8) return null;
    if (offset + length > this.pending.byteLength) return null;
    let value = keepMarker ? first : first & (0xff >> length);
    let unknown = !keepMarker && (first & (0xff >> length)) === 0xff >> length;
    for (let index = 1; index < length; index += 1) {
      const byte = this.pending[offset + index]!;
      if (byte !== 0xff) unknown = false;
      value = value * 256 + byte;
    }
    return { value, length, unknown };
  }

  private drain(frames: StreamFrame[]) {
    for (;;) {
      // Close any container whose declared end has been reached. A closing
      // BlockGroup is where its Block finally becomes classifiable.
      while (this.stack.length && this.origin >= this.stack.at(-1)!.end) {
        const closed = this.stack.pop()!;
        if (closed.id === ID_BLOCK_GROUP) this.closeGroup(frames);
      }

      if (this.skipRemaining > 0) {
        const step = Math.min(this.skipRemaining, this.pending.byteLength);
        if (step === 0) return;
        this.consume(step);
        this.skipRemaining -= step;
        continue;
      }

      const id = this.readVint(0, true);
      if (!id) return;
      const size = this.readVint(id.length, false);
      if (!size) return;
      const headerLength = id.length + size.length;
      const bodyStart = this.origin + headerLength;
      const end = size.unknown ? Infinity : bodyStart + size.value;

      if (CONTAINERS.has(id.value)) {
        this.stack.push({ id: id.value, end });
        if (id.value === ID_CLUSTER) this.clusterTimeMs = 0;
        if (id.value === ID_BLOCK_GROUP) {
          // A group left open by a malformed size must not leak into the next.
          this.closeGroup(frames);
          this.groupReferenced = false;
        }
        this.consume(headerLength);
        continue;
      }

      // Everything below needs its body in hand.
      const needed = headerLength + size.value;
      if (BUFFERED.has(id.value) || this.isLeafOfInterest(id.value)) {
        if (this.pending.byteLength < needed) return;
        this.handle(id.value, headerLength, size.value, frames);
        this.consume(needed);
        continue;
      }

      // Uninteresting: step past it without ever holding it.
      this.consume(Math.min(headerLength, this.pending.byteLength));
      this.skipRemaining = size.unknown ? 0 : size.value;
    }
  }

  private isLeafOfInterest(id: number) {
    return (
      id === ID_CLUSTER_TIMESTAMP ||
      id === ID_SIMPLE_BLOCK ||
      id === ID_BLOCK ||
      id === ID_REFERENCE_BLOCK ||
      id === ID_TIMESTAMP_SCALE ||
      id === ID_DURATION
    );
  }

  /** Emits the held Block, now that its group's ReferenceBlock is known. */
  private closeGroup(frames: StreamFrame[]) {
    const frame = this.groupFrame;
    this.groupFrame = null;
    if (!frame) return;
    frame.keyframe = !this.groupReferenced;
    this.groupReferenced = false;
    frames.push(frame);
  }

  private handle(
    id: number,
    headerLength: number,
    size: number,
    frames: StreamFrame[],
  ) {
    const view = this.view();
    const body = headerLength;

    if (id === ID_TIMESTAMP_SCALE)
      this.timestampScaleNs = readUint(view, body, size);
    else if (id === ID_DURATION) {
      const raw = size === 4 ? view.getFloat32(body) : size === 8 ? view.getFloat64(body) : null;
      if (raw != null)
        this.durationSeconds = (raw * this.timestampScaleNs) / 1e9;
    } else if (id === ID_INFO) {
      this.walkChildren(body, body + size, (childId, childBody, childSize) => {
        if (childId === ID_TIMESTAMP_SCALE)
          this.timestampScaleNs = readUint(view, childBody, childSize);
        else if (childId === ID_DURATION) {
          const raw =
            childSize === 4
              ? view.getFloat32(childBody)
              : childSize === 8
                ? view.getFloat64(childBody)
                : null;
          if (raw != null)
            this.durationSeconds = (raw * this.timestampScaleNs) / 1e9;
        }
      });
    } else if (id === ID_TRACKS) {
      this.walkChildren(body, body + size, (childId, childBody, childSize) => {
        if (childId === ID_TRACK_ENTRY)
          this.tracks.push(this.parseTrack(childBody, childBody + childSize));
      });
      this.headerComplete = true;
    } else if (id === ID_CLUSTER_TIMESTAMP) {
      this.clusterTimeMs =
        (readUint(view, body, size) * this.timestampScaleNs) / 1_000_000;
    } else if (id === ID_REFERENCE_BLOCK) {
      // Its presence is the whole signal: this group depends on another frame.
      this.groupReferenced = true;
    } else if (id === ID_SIMPLE_BLOCK || id === ID_BLOCK) {
      const simple = id === ID_SIMPLE_BLOCK;
      const frame = this.readBlock(body, body + size, simple);
      if (!frame) return;
      // A SimpleBlock carries its own flag and can be emitted immediately; a
      // Block has to wait for its group to close.
      if (simple) frames.push(frame);
      else this.groupFrame = frame;
    }
  }

  private walkChildren(
    start: number,
    end: number,
    visit: (id: number, body: number, size: number) => void,
  ) {
    let offset = start;
    while (offset < end) {
      const id = this.readVint(offset, true);
      if (!id) return;
      const size = this.readVint(offset + id.length, false);
      if (!size) return;
      const body = offset + id.length + size.length;
      if (body + size.value > end) return;
      visit(id.value, body, size.value);
      const next = body + size.value;
      if (next <= offset) return;
      offset = next;
    }
  }

  private parseTrack(start: number, end: number): StreamTrack {
    const view = this.view();
    const track: StreamTrack = {
      number: 0,
      kind: "other",
      codecId: "",
      codecPrivate: null,
    };
    this.walkChildren(start, end, (id, body, size) => {
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
      } else if (id === ID_CODEC_ID)
        track.codecId = new TextDecoder()
          .decode(this.pending.subarray(body, body + size))
          .replace(/\0+$/, "");
      else if (id === ID_CODEC_PRIVATE)
        track.codecPrivate = this.pending.slice(body, body + size);
      else if (id === ID_VIDEO || id === ID_AUDIO)
        this.walkChildren(body, body + size, (innerId, innerBody, innerSize) => {
          if (innerId === ID_PIXEL_WIDTH)
            track.width = readUint(view, innerBody, innerSize);
          else if (innerId === ID_PIXEL_HEIGHT)
            track.height = readUint(view, innerBody, innerSize);
          else if (innerId === ID_CHANNELS)
            track.channels = readUint(view, innerBody, innerSize);
          else if (innerId === ID_SAMPLING_FREQUENCY)
            track.sampleRate =
              innerSize === 4
                ? view.getFloat32(innerBody)
                : innerSize === 8
                  ? view.getFloat64(innerBody)
                  : undefined;
        });
    });
    return track;
  }

  private readBlock(start: number, end: number, simple: boolean) {
    const track = this.readVint(start, false);
    if (!track) return null;
    const headerEnd = start + track.length + 3;
    if (headerEnd > end) return null;
    const view = this.view();
    const relative = view.getInt16(start + track.length);
    const flags = this.pending[start + track.length + 2]!;
    return {
      track: track.value,
      timeMs:
        this.clusterTimeMs + (relative * this.timestampScaleNs) / 1_000_000,
      // A SimpleBlock says so directly. A Block is decided by its group, which
      // overwrites this once the ReferenceBlock question is settled.
      keyframe: simple ? (flags & 0x80) !== 0 : false,
      // Copied: the pending buffer is trimmed as soon as this returns.
      data: this.pending.slice(headerEnd, end),
    };
  }
}

function readUint(view: DataView, start: number, size: number) {
  let value = 0;
  for (let index = 0; index < size; index += 1)
    value = value * 256 + view.getUint8(start + index);
  return value;
}
