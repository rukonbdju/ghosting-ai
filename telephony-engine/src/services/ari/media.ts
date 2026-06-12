import { config } from 'dotenv';
config();
import * as dgram from 'dgram';
import { VAD } from '../../utils/vad.js';
import { parseRtpHeader, buildRtpPacket, ulawToSlin16, slin16ToUlaw } from '../../utils/audio-utils.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Media');
const MEDIA_PORT = parseInt(process.env.MEDIA_PORT ?? '9999', 10);

interface JitterEntry {
  seq: number;
  payload: Buffer;
}

interface CallSession {
  vad: VAD;
  ssrc: number | null;
  payloadType: number | null;
  remoteAddress: string | null;
  remotePort: number | null;
  txSeq: number;
  txTimestamp: number;
  jitterBuf: JitterEntry[];
  lastSeq: number | null;
  onSpeechEnd: (pcm: Buffer) => void;
  txQueue: Buffer[];
  txInterval: NodeJS.Timeout | null;
  txStartTime: number | null;
  txSentPackets: number;
}

export class MediaServer {
  private socket!: dgram.Socket;
  private sessions = new Map<string, CallSession>();

  async start(): Promise<void> {
    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      this._onUdpMessage(msg, rinfo);
    });

    this.socket.on('error', (err) => {
      log.error(`UDP socket error: ${err.message}`);
    });

    await new Promise<void>((resolve) => {
      this.socket.bind(MEDIA_PORT, '0.0.0.0', () => {
        log.info(`UDP media server listening on port ${MEDIA_PORT}`);
        resolve();
      });
    });
  }

  registerCall(channelId: string, onSpeechEnd: (pcm: Buffer) => void): void {
    if (this.sessions.has(channelId)) return;

    const vad = new VAD({
      speechThreshold:  parseInt(process.env.SPEECH_THRESHOLD  ?? '600'),
      silenceTimeoutMs: parseInt(process.env.VAD_SILENCE_MS    ?? '700'),
      maxSpeechMs:      parseInt(process.env.VAD_MAX_SPEECH_MS ?? '30000'),
    });
    vad.on('speech_start', () => log.debug(`[${channelId}] speech_start`));
    vad.on('speech_end', (pcm: Buffer) => {
      log.debug(`[${channelId}] speech_end — ${pcm.length} bytes`);
      onSpeechEnd(pcm);
    });

    this.sessions.set(channelId, {
      vad,
      ssrc: null,
      payloadType: null,
      remoteAddress: null,
      remotePort: null,
      txSeq: Math.floor(Math.random() * 0xffff),
      txTimestamp: Math.floor(Math.random() * 0xffffffff),
      jitterBuf: [],
      lastSeq: null,
      onSpeechEnd,
      txQueue: [],
      txInterval: null,
      txStartTime: null,
      txSentPackets: 0,
    });

    log.info(`[${channelId}] session registered`);
  }

  deregisterCall(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    if (session.txInterval) {
      clearInterval(session.txInterval);
      session.txInterval = null;
    }
    session.vad.reset();
    session.vad.removeAllListeners();
    this.sessions.delete(channelId);
    log.info(`[${channelId}] session deregistered`);
  }

  sendAudio(channelId: string, pcm: Buffer): void {
    const session = this.sessions.get(channelId);
    if (!session?.remoteAddress || !session.remotePort) {
      log.warn(`[${channelId}] Cannot send audio — remote addr unknown`);
      return;
    }

    if (pcm.length === 0) {
      log.warn(`[${channelId}] sendAudio called with 0 bytes`);
      return;
    }

    const isUlaw = session.payloadType === 0;

    const FRAME_BYTES       = isUlaw ? 160 : 640;
    const SAMPLES_PER_FRAME = isUlaw ? 160 : 320;
    const pType             = isUlaw ? 0 : 11; // Hardcode 11 for slin16 to prevent CN silence

    let data: Buffer;
    if (isUlaw) {
      data = slin16ToUlaw(pcm);
    } else {
      data = Buffer.from(pcm);
      data.swap16();
    }

    log.info(`[${channelId}] Queuing ${data.length} bytes for RTP playback...`);

    for (let offset = 0; offset < data.length; offset += FRAME_BYTES) {
      const frame  = data.subarray(offset, offset + FRAME_BYTES);
      const packet = buildRtpPacket(frame, session.txSeq, session.txTimestamp, 0xdeadbeef, pType);
      session.txQueue.push(packet);
      session.txSeq       = (session.txSeq + 1) & 0xffff;
      session.txTimestamp = (session.txTimestamp + SAMPLES_PER_FRAME) >>> 0;
    }

    if (!session.txInterval) {
      session.txStartTime = Date.now();
      session.txSentPackets = 0;
      session.txInterval = setInterval(() => {
        if (session.txQueue.length === 0) {
          if (session.txInterval) {
            clearInterval(session.txInterval);
            session.txInterval = null;
          }
          log.info(`[${channelId}] Finished sending RTP queue`);
          return;
        }

        const now = Date.now();
        const expectedPackets = Math.floor((now - session.txStartTime!) / 20) + 1;

        while (session.txSentPackets < expectedPackets && session.txQueue.length > 0) {
          const pkt = session.txQueue.shift()!;
          this.socket.send(pkt, session.remotePort!, session.remoteAddress!);
          session.txSentPackets++;
        }
      }, 5);
    }
  }

  private _onUdpMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const header = parseRtpHeader(msg);
    if (!header) return;

    let session: CallSession | undefined;

    for (const [id, s] of this.sessions) {
      if (s.ssrc === null) {
        if (header.payloadType === 13) return; // Ignore Comfort Noise latching
        s.ssrc          = header.ssrc;
        s.payloadType   = header.payloadType;
        s.remoteAddress = rinfo.address;
        s.remotePort    = rinfo.port;
        session = s;
        const codecName  = header.payloadType === 0 ? 'ulaw' : header.payloadType === 8 ? 'alaw' : `PT${header.payloadType}`;
        log.info(`[${id}] SSRC latched: 0x${header.ssrc.toString(16)}, remote ${rinfo.address}:${rinfo.port}, codec=${codecName}`);
        break;
      } else if (s.ssrc === header.ssrc) {
        session = s;
        break;
      }
    }

    if (!session) return;

    const payload = msg.subarray(header.headerLength);
    if (payload.length === 0) return;

    const JITTER_WINDOW = 4;

    session.jitterBuf.push({ seq: header.sequenceNumber, payload: Buffer.from(payload) });

    session.jitterBuf.sort((a, b) => {
      const d = ((a.seq - b.seq) + 0x10000) & 0xffff;
      return d === 0 ? 0 : d < 0x8000 ? -1 : 1;
    });

    while (session.jitterBuf.length > 0) {
      const front    = session.jitterBuf[0];
      const isNext   = session.lastSeq === null ||
                       ((front.seq - session.lastSeq + 0x10000) & 0xffff) === 1;
      const isFull   = session.jitterBuf.length >= JITTER_WINDOW;

      if (!isNext && !isFull) break;

      session.jitterBuf.shift();
      session.lastSeq = front.seq;

      let pcm: Buffer;
      if (session.payloadType === 0) {
        pcm = ulawToSlin16(front.payload);
      } else {
        pcm = Buffer.from(front.payload);
        pcm.swap16(); 
      }
      session.vad.feed(pcm);
    }
  }
}
