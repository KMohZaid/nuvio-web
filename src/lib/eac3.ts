/**
 * Derives AC-3 / E-AC-3 decoder configuration from the bitstream.
 *
 * Matroska stores no CodecPrivate for these codecs — the parameters live in
 * every audio frame's header — but MP4 requires a `dac3` or `dec3` box in the
 * sample entry. So the first sync frame has to be parsed and the box rebuilt,
 * which is the one piece of real bitstream work in the whole remuxer.
 *
 * Fields follow ETSI TS 102 366; the box layouts follow the AC3SpecificBox and
 * EC3SpecificBox definitions carried in ISO/IEC 14496-1.
 */

const SYNC_WORD = 0x0b77;

/** Channel count per acmod, before the LFE channel is added. */
const ACMOD_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];
const FSCOD_RATES = [48000, 44100, 32000];
/** Used when fscod is 3, which signals the half-rate variants. */
const FSCOD2_RATES = [24000, 22050, 16000];

class BitReader {
  private bit = 0;
  constructor(private readonly bytes: Uint8Array) {}
  read(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = this.bytes[this.bit >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit += 1;
    }
    return value;
  }
}

export type Ac3Info = {
  eac3: boolean;
  bsid: number;
  bsmod: number;
  fscod: number;
  acmod: number;
  lfeon: number;
  sampleRate: number;
  channels: number;
  /** Nominal rate in kbit/s, which the dec3 box carries. */
  dataRateKbps: number;
};

/** Finds the 0x0B77 sync word; a Matroska block should open with it. */
function findSync(bytes: Uint8Array): number {
  for (let index = 0; index + 1 < Math.min(bytes.length, 4096); index += 1)
    if (((bytes[index]! << 8) | bytes[index + 1]!) === SYNC_WORD) return index;
  return -1;
}

export function parseAc3(frame: Uint8Array): Ac3Info | null {
  const start = findSync(frame);
  if (start < 0) return null;
  const reader = new BitReader(frame.subarray(start + 2));

  // bsid sits at a fixed offset from the sync word in both variants, and
  // decides which layout the rest of the header uses: 16 means E-AC-3.
  const probe = new BitReader(frame.subarray(start + 2));
  probe.read(16 + 16); // skip enough to reach bsid in the AC-3 layout
  const isEac3 = ((frame[start + 5] ?? 0) >> 3) === 16;

  if (isEac3) {
    reader.read(2); // strmtyp
    reader.read(3); // substreamid
    const frmsiz = reader.read(11);
    const fscod = reader.read(2);
    let numblkscod = 3;
    let sampleRate: number;
    if (fscod === 3) {
      const fscod2 = reader.read(2);
      sampleRate = FSCOD2_RATES[fscod2] ?? 24000;
    } else {
      numblkscod = reader.read(2);
      sampleRate = FSCOD_RATES[fscod] ?? 48000;
    }
    const acmod = reader.read(3);
    const lfeon = reader.read(1);
    const bsid = reader.read(5);
    const blocks = [1, 2, 3, 6][numblkscod] ?? 6;
    const frameBytes = (frmsiz + 1) * 2;
    // Each block is 256 samples, so the frame's duration gives its bitrate.
    const seconds = (blocks * 256) / sampleRate;
    return {
      eac3: true,
      bsid,
      bsmod: 0,
      fscod,
      acmod,
      lfeon,
      sampleRate,
      channels: (ACMOD_CHANNELS[acmod] ?? 2) + lfeon,
      dataRateKbps: Math.round((frameBytes * 8) / seconds / 1000),
    };
  }

  const fscod = reader.read(2);
  reader.read(6); // frmsizecod
  const bsid = reader.read(5);
  const bsmod = reader.read(3);
  const acmod = reader.read(3);
  if ((acmod & 0x1) && acmod !== 1) reader.read(2); // cmixlev
  if (acmod & 0x4) reader.read(2); // surmixlev
  if (acmod === 2) reader.read(2); // dsurmod
  const lfeon = reader.read(1);
  return {
    eac3: false,
    bsid,
    bsmod,
    fscod,
    acmod,
    lfeon,
    sampleRate: FSCOD_RATES[fscod] ?? 48000,
    channels: (ACMOD_CHANNELS[acmod] ?? 2) + lfeon,
    dataRateKbps: 640,
  };
}

class BitWriter {
  private bits: number[] = [];
  write(value: number, count: number) {
    for (let index = count - 1; index >= 0; index -= 1)
      this.bits.push((value >> index) & 1);
    return this;
  }
  bytes(): Uint8Array {
    while (this.bits.length % 8) this.bits.push(0);
    const out = new Uint8Array(this.bits.length / 8);
    this.bits.forEach((bit, index) => {
      if (bit) out[index >> 3]! |= 0x80 >> (index & 7);
    });
    return out;
  }
}

/** EC3SpecificBox payload for a single independent substream. */
export function buildDec3(info: Ac3Info): Uint8Array {
  return new BitWriter()
    .write(info.dataRateKbps, 13)
    .write(0, 3) // num_ind_sub - 1
    .write(info.fscod, 2)
    .write(info.bsid, 5)
    .write(0, 1) // reserved
    .write(0, 1) // asvc
    .write(info.bsmod, 3)
    .write(info.acmod, 3)
    .write(info.lfeon, 1)
    .write(0, 3) // reserved
    .write(0, 4) // num_dep_sub
    .write(0, 1) // reserved, present only when num_dep_sub is zero
    .bytes();
}

/** AC3SpecificBox payload. */
export function buildDac3(info: Ac3Info): Uint8Array {
  return new BitWriter()
    .write(info.fscod, 2)
    .write(info.bsid, 5)
    .write(info.bsmod, 3)
    .write(info.acmod, 3)
    .write(info.lfeon, 1)
    .write(0x10, 5) // bit_rate_code — nominal, not enforced by decoders
    .write(0, 5) // reserved
    .bytes();
}
