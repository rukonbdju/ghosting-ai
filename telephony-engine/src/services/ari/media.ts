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
  remoteAddress: string | null;
  remotePort: number | null;
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
      remoteAddress: null,
      remotePort: null,
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

    log.info(`[${channelId}] Queuing ${pcm.length} bytes for raw UDP playback...`);

    const FRAME_BYTES = 640; // 20ms @ 16kHz × 2 bytes/sample

    // No RTP headers, no swap16. Asterisk expects pure Little Endian slin16.
    for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
      const frame = pcm.subarray(offset, offset + FRAME_BYTES);
      session.txQueue.push(frame);
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
          log.info(`[${channelId}] Finished sending audio queue`);
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
    if (msg.length === 0) return;

    let session: CallSession | undefined;

    for (const [id, s] of this.sessions) {
      if (s.remoteAddress === null) {
        s.remoteAddress = rinfo.address;
        s.remotePort    = rinfo.port;
        session = s;
        log.info(`[${id}] Latched RAW UDP remote ${rinfo.address}:${rinfo.port}`);
        break;
      } else if (s.remoteAddress === rinfo.address && s.remotePort === rinfo.port) {
        session = s;
        break;
      }
    }

    if (!session) return;

    // msg is pure slin16 Little Endian PCM
    session.vad.feed(msg);
  }
}
