import {
  Conversion,
  Input,
  MATROSKA,
  Mp4OutputFormat,
  NullTarget,
  Output,
  UrlSource,
} from "mediabunny";

const defaultSample =
  "https://raw.githubusercontent.com/ietf-wg-cellar/matroska-test-files/master/test_files/test8.mkv";
const url = process.argv[2] || defaultSample;
const until = Number(process.argv[3] || 12);

if (!Number.isFinite(until) || until <= 0) {
  throw new Error("The optional duration must be a positive number of seconds.");
}

let readBytes = 0;
let ftypBytes = 0;
let moovBytes = 0;
let pendingMoof = null;
const fragments = [];

const source = new UrlSource(url, {
  maxCacheSize: 4 * 1024 * 1024,
  parallelism: 1,
});
source.onread = (start, end) => {
  readBytes += Math.max(0, end - start);
};

const input = new Input({ source, formats: [MATROSKA] });
const output = new Output({
  format: new Mp4OutputFormat({
    fastStart: "fragmented",
    minimumFragmentDuration: 1,
    onFtyp(bytes) {
      ftypBytes = bytes.byteLength;
    },
    onMoov(bytes) {
      moovBytes = bytes.byteLength;
    },
    onMoof(bytes, _position, timestamp) {
      if (pendingMoof) {
        throw new Error("The writer emitted two moof boxes without an mdat.");
      }
      pendingMoof = { bytes: bytes.byteLength, timestamp };
    },
    onMdat(bytes) {
      if (!pendingMoof) {
        throw new Error("The writer emitted an mdat without a moof.");
      }
      fragments.push({
        timestamp: pendingMoof.timestamp,
        bytes: pendingMoof.bytes + bytes.byteLength,
      });
      pendingMoof = null;
    },
  }),
  target: new NullTarget(),
});

try {
  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    showWarnings: false,
  });
  const trackTypes = conversion.utilizedTracks.map((track) => track.type);
  const discardedTracks = conversion.discardedTracks.map(({ track, reason }) => ({
    type: track.type,
    reason,
  }));

  if (!conversion.isValid || !trackTypes.includes("video") || !trackTypes.includes("audio")) {
    throw new Error(
      `No compatible audio/video pair: ${JSON.stringify(discardedTracks)}`,
    );
  }

  // Exercise the same stop/resume pattern used by the PWA instead of doing a
  // single monolithic conversion. This catches timestamp or writer state that
  // only breaks after the first SourceBuffer-sized window.
  let target = Math.min(3, until);
  while (conversion.state !== "done") {
    await conversion.execute({ until: target });
    if (target >= until) break;
    target = Math.min(until, target + 2);
  }

  if (!ftypBytes || !moovBytes || !fragments.length || pendingMoof) {
    throw new Error("The output is missing a complete initialization or media segment.");
  }
  for (let index = 1; index < fragments.length; index += 1) {
    if (fragments[index].timestamp <= fragments[index - 1].timestamp) {
      throw new Error(`Fragment timestamps are not increasing at index ${index}.`);
    }
  }

  const mime = await output.getMimeType();
  const mediaBytes = fragments.reduce((sum, fragment) => sum + fragment.bytes, 0);
  console.log(
    JSON.stringify(
      {
        source: url,
        verifiedThroughSeconds: until,
        mime,
        trackTypes,
        discardedTracks,
        initializationBytes: ftypBytes + moovBytes,
        fragments: fragments.length,
        firstFragmentTimestamp: fragments[0].timestamp,
        lastFragmentTimestamp: fragments.at(-1).timestamp,
        mediaBytes,
        readBytes,
      },
      null,
      2,
    ),
  );
} finally {
  input.dispose();
}
