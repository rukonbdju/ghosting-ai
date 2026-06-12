export interface RtpHeader {
  version: number;
  padding: boolean;
  extension: boolean;
  csrcCount: number;
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  headerLength: number;
}

export function parseRtpHeader(buf: Buffer): RtpHeader | null {
  if (buf.length < 12) return null;
  const version = (buf[0] >> 6) & 0x03;
  if (version !== 2) return null;
  const padding   = !!(buf[0] & 0x20);
  const extension = !!(buf[0] & 0x10);
  const csrcCount = buf[0] & 0x0f;
  const marker      = !!(buf[1] & 0x80);
  const payloadType = buf[1] & 0x7f;
  const sequenceNumber = buf.readUInt16BE(2);
  const timestamp      = buf.readUInt32BE(4);
  const ssrc           = buf.readUInt32BE(8);
  let headerLength = 12 + csrcCount * 4;
  if (extension && buf.length >= headerLength + 4) {
    const extLen = buf.readUInt16BE(headerLength + 2);
    headerLength += 4 + extLen * 4;
  }
  return { version, padding, extension, csrcCount, marker, payloadType, sequenceNumber, timestamp, ssrc, headerLength };
}

/** Wraps raw slin16 PCM in a minimal WAV container for Whisper.cpp */
export function buildWavBuffer(pcm: Buffer, sampleRate = 16000, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate   = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize   = pcm.length;
  const header     = Buffer.allocUnsafe(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);          // PCM chunk size
  header.writeUInt16LE(1, 20);           // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

/** Builds a minimal RTP packet (no CSRC, no extension) */
export function buildRtpPacket(
  payload: Buffer,
  seq: number,
  timestamp: number,
  ssrc: number,
  payloadType = 11,  // L16 mono
): Buffer {
  const header = Buffer.allocUnsafe(12);
  header[0] = 0x80;  // V=2, P=0, X=0, CC=0
  header[1] = payloadType & 0x7f;
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

// μ-law decode table: ulaw byte → int16 PCM sample
const ULAW_DECODE: number[] = Array.from({ length: 256 }, (_, i) => {
  const u = ~i & 0xFF;
  const sign = u & 0x80 ? -1 : 1;
  const exp  = (u >> 4) & 0x07;
  const mant = u & 0x0F;
  const mag  = ((mant << 3) | 0x84) << exp;
  return sign * (mag - 0x84);
});

/**
 * Decode 8-bit μ-law buffer and upsample 8 kHz → 16 kHz (linear interpolation).
 * Each ulaw byte → 4 output bytes (2 int16 LE samples).
 */
export function ulawToSlin16(ulaw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(ulaw.length * 4);
  let prev = 0;
  for (let i = 0; i < ulaw.length; i++) {
    const curr = ULAW_DECODE[ulaw[i]];
    out.writeInt16LE((prev + curr) >> 1, i * 4);
    out.writeInt16LE(curr, i * 4 + 2);
    prev = curr;
  }
  return out;
}

/**
 * Encode 16 kHz slin16 buffer to 8 kHz ulaw:
 * downsample 2× (every other sample) then μ-law encode.
 */
export function slin16ToUlaw(pcm: Buffer): Buffer {
  const out = Buffer.allocUnsafe(pcm.length >> 2); // 4 input bytes → 1 output byte
  for (let i = 0, j = 0; i < pcm.length; i += 4, j++) {
    let s = pcm.readInt16LE(i);
    const sign = s < 0 ? (s = -s, 0x80) : 0;
    if (s > 32767) s = 32767;
    s += 0x84;
    let exp = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
    out[j] = (~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0F))) & 0xFF;
  }
  return out;
}

/**
 * Resample 16-bit signed little-endian PCM from one rate to another.
 * Uses linear interpolation — good enough quality for voice.
 */
export function resampleSlin16(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input;
  const inSamples  = input.length >> 1;
  const outSamples = Math.round(inSamples * toRate / fromRate);
  const out  = Buffer.allocUnsafe(outSamples * 2);
  const ratio = (inSamples - 1) / Math.max(outSamples - 1, 1);
  for (let i = 0; i < outSamples; i++) {
    const src   = i * ratio;
    const lo    = Math.floor(src);
    const hi    = Math.min(lo + 1, inSamples - 1);
    const frac  = src - lo;
    const s0    = input.readInt16LE(lo * 2);
    const s1    = input.readInt16LE(hi * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}

/** Calculate RMS energy of a 16-bit PCM buffer (little-endian samples) */
export function rmsEnergy(buf: Buffer): number {
  const samples = buf.length >> 1;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length - 1; i += 2) {
    const s = buf.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}
