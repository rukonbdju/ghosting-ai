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
