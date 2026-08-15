/**
 * Fragmented MP4 writer.
 *
 * Takes encoded samples pulled out of Matroska and boxes them as fMP4 for
 * Media Source Extensions. Nothing is decoded or re-encoded — the same
 * elementary streams come out the other side, which is why this is cheap
 * enough to run on a phone.
 *
 * Two outputs matter. The init segment (ftyp + moov) declares the tracks and
 * carries the decoder configuration; each media segment (moof + mdat) carries
 * a run of samples with their durations and keyframe flags. MSE requires the
 * init segment first and rejects everything after it if the configuration is
 * wrong, which at least makes failure loud.
 */

const text = (value: string) =>
  Uint8Array.from(value, (character) => character.charCodeAt(0));

const u32 = (value: number) =>
  new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);

const u16 = (value: number) =>
  new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);

/** 64-bit, written as two 32-bit halves to stay clear of bitwise coercion. */
const u64 = (value: number) =>
  concat(u32(Math.floor(value / 2 ** 32)), u32(value >>> 0));

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const box = (type: string, ...payload: Uint8Array[]) => {
  const body = concat(...payload);
  return concat(u32(body.byteLength + 8), text(type), body);
};

const fullBox = (
  type: string,
  version: number,
  flags: number,
  ...payload: Uint8Array[]
) =>
  box(
    type,
    new Uint8Array([
      version,
      (flags >>> 16) & 0xff,
      (flags >>> 8) & 0xff,
      flags & 0xff,
    ]),
    ...payload,
  );

export type MuxTrack = {
  id: number;
  kind: "video" | "audio";
  /** Sample entry type: av01, avc1, hvc1 or mp4a. */
  sampleEntry: string;
  /** The codec-specific configuration box payload, verbatim. */
  config: Uint8Array;
  timescale: number;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
};

export type MuxSample = {
  data: Uint8Array;
  durationTicks: number;
  keyframe: boolean;
};

// A 3x3 unity matrix, required in tkhd and mvhd.
const UNITY_MATRIX = concat(
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
);

/**
 * Wraps an AudioSpecificConfig in the descriptor chain MP4 expects. Matroska
 * stores the bare config, so this scaffolding has to be rebuilt.
 */
function esds(config: Uint8Array) {
  const descriptor = (tag: number, ...payload: Uint8Array[]) => {
    const body = concat(...payload);
    // Only short descriptors occur here; an AudioSpecificConfig is a handful
    // of bytes, so the single-byte length form is always sufficient.
    return concat(new Uint8Array([tag, body.byteLength]), body);
  };
  const decoderSpecific = descriptor(0x05, config);
  const decoderConfig = descriptor(
    0x04,
    new Uint8Array([0x40, 0x15]), // AAC, audio stream
    new Uint8Array([0, 0, 0]), // buffer size
    u32(0), // max bitrate
    u32(0), // average bitrate
    decoderSpecific,
  );
  const slConfig = descriptor(0x06, new Uint8Array([0x02]));
  return fullBox(
    "esds",
    0,
    0,
    descriptor(0x03, u16(1), new Uint8Array([0]), decoderConfig, slConfig),
  );
}

function sampleEntryFor(track: MuxTrack) {
  const reserved = new Uint8Array(6);
  if (track.kind === "video") {
    const configBox =
      track.sampleEntry === "av01"
        ? box("av1C", track.config)
        : track.sampleEntry === "hvc1"
          ? box("hvcC", track.config)
          : box("avcC", track.config);
    return box(
      track.sampleEntry,
      reserved,
      u16(1), // data reference index
      u16(0),
      u16(0),
      u32(0),
      u32(0),
      u32(0),
      u16(track.width ?? 0),
      u16(track.height ?? 0),
      u32(0x00480000), // 72dpi horizontal
      u32(0x00480000), // 72dpi vertical
      u32(0),
      u16(1), // frame count
      new Uint8Array(32), // compressor name
      u16(0x0018), // depth
      u16(0xffff),
      configBox,
    );
  }
  return box(
    "mp4a",
    reserved,
    u16(1),
    u32(0),
    u32(0),
    u16(track.channels ?? 2),
    u16(16), // sample size
    u16(0),
    u16(0),
    u32((track.sampleRate ?? 48000) << 16),
    esds(track.config),
  );
}

function trak(track: MuxTrack) {
  const handler = track.kind === "video" ? "vide" : "soun";
  const mediaHeader =
    track.kind === "video"
      ? fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0))
      : fullBox("smhd", 0, 0, u16(0), u16(0));

  return box(
    "trak",
    fullBox(
      "tkhd",
      0,
      3, // enabled | in movie
      u32(0),
      u32(0),
      u32(track.id),
      u32(0),
      u32(0), // duration: unknown for a fragmented file
      u32(0),
      u32(0),
      u16(0),
      u16(0),
      u16(track.kind === "audio" ? 0x0100 : 0),
      u16(0),
      UNITY_MATRIX,
      u32((track.width ?? 0) << 16),
      u32((track.height ?? 0) << 16),
    ),
    box(
      "mdia",
      fullBox(
        "mdhd",
        0,
        0,
        u32(0),
        u32(0),
        u32(track.timescale),
        u32(0),
        u16(0x55c4), // undetermined language
        u16(0),
      ),
      fullBox(
        "hdlr",
        0,
        0,
        u32(0),
        text(handler),
        u32(0),
        u32(0),
        u32(0),
        text(track.kind === "video" ? "VideoHandler\0" : "SoundHandler\0"),
      ),
      box(
        "minf",
        mediaHeader,
        box(
          "dinf",
          fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)),
        ),
        box(
          "stbl",
          fullBox("stsd", 0, 0, u32(1), sampleEntryFor(track)),
          // The sample tables stay empty: every sample arrives in a fragment.
          fullBox("stts", 0, 0, u32(0)),
          fullBox("stsc", 0, 0, u32(0)),
          fullBox("stsz", 0, 0, u32(0), u32(0)),
          fullBox("stco", 0, 0, u32(0)),
        ),
      ),
    ),
  );
}

export function buildInitSegment(tracks: MuxTrack[]): Uint8Array {
  const ftyp = box(
    "ftyp",
    text("iso5"),
    u32(512),
    text("iso5"),
    text("iso6"),
    text("mp41"),
  );
  const mvex = box(
    "mvex",
    ...tracks.map((track) =>
      fullBox(
        "trex",
        0,
        0,
        u32(track.id),
        u32(1), // default sample description index
        u32(0),
        u32(0),
        u32(0),
      ),
    ),
  );
  const moov = box(
    "moov",
    fullBox(
      "mvhd",
      0,
      0,
      u32(0),
      u32(0),
      u32(1000),
      u32(0), // duration unknown
      u32(0x00010000),
      u16(0x0100),
      u16(0),
      u32(0),
      u32(0),
      UNITY_MATRIX,
      u32(0),
      u32(0),
      u32(0),
      u32(0),
      u32(0),
      u32(0),
      u32(tracks.length + 1),
    ),
    ...tracks.map(trak),
    mvex,
  );
  return concat(ftyp, moov);
}

/** Sample flags: an I-frame depends on nothing and is a sync sample. */
const sampleFlags = (keyframe: boolean) =>
  keyframe ? 0x02000000 : 0x01010000;

export function buildMediaSegment(
  sequence: number,
  trackId: number,
  baseMediaDecodeTime: number,
  samples: MuxSample[],
): Uint8Array {
  const trunEntries = concat(
    ...samples.map((sample) =>
      concat(
        u32(sample.durationTicks),
        u32(sample.data.byteLength),
        u32(sampleFlags(sample.keyframe)),
      ),
    ),
  );

  // trun's data offset is relative to the start of the moof, so the moof has
  // to be built once to learn its own size before the offset can be written.
  const build = (dataOffset: number) =>
    box(
      "moof",
      fullBox("mfhd", 0, 0, u32(sequence)),
      box(
        "traf",
        // default-base-is-moof keeps offsets independent of the file position,
        // which is what makes a segment appendable on its own.
        fullBox("tfhd", 0, 0x020000, u32(trackId)),
        fullBox("tfdt", 1, 0, u64(baseMediaDecodeTime)),
        fullBox(
          "trun",
          0,
          0x000701, // data offset + duration + size + flags per sample
          u32(samples.length),
          u32(dataOffset),
          trunEntries,
        ),
      ),
    );

  const provisional = build(0);
  const moof = build(provisional.byteLength + 8);
  const mdat = box("mdat", ...samples.map((sample) => sample.data));
  return concat(moof, mdat);
}
