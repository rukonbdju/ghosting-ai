import { config } from 'dotenv';
config();
import * as dgram from 'dgram';
import { VAD } from '../../utils/vad.js';
import { parseRtpHeader, buildRtpPacket } from '../../utils/audio-utils.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Media');
const MEDIA_PORT = parseInt(process.env.MEDIA_PORT ?? '9999', 10);

interface CallSession {
  vad: VAD;
  /** SSRC latched from first valid RTP packet */
  ssrc: number | null;
  /** Address of Asterisk's RTP sender — used to send audio back */
  remoteAddress: string | null;
  remotePort: number | null;
  /** Rolling sequence/timestamp counters for outbound RTP */
  txSeq: number;
  txTimestamp: number;
  /** Callback invoked when VAD detects end of speech */
  onSpeechEnd: (pcm: Buffer) => void;
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

    const vad = new VAD();
    vad.on('speech_start', () => log.debug(`[${channelId}] speech_start`));
    vad.on('speech_end', (pcm: Buffer) => {
      log.debug(`[${channelId}] speech_end — ${pcm.length} bytes`);
      onSpeechEnd(pcm);
    });

    this.sessions.set(channelId, {
      vad,
      ssrc: null,
      remoteAddress: null,
      remotePort: null,
      txSeq: Math.floor(Math.random() * 0xffff),
      txTimestamp: Math.floor(Math.random() * 0xffffffff),
      onSpeechEnd,
    });

    log.info(`[${channelId}] session registered`);
  }

  deregisterCall(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    session.vad.reset();
    session.vad.removeAllListeners();
    this.sessions.delete(channelId);
    log.info(`[${channelId}] session deregistered`);
  }

  /**
   * Sends raw PCM audio back to Asterisk as RTP packets.
   * Splits into 20ms frames (640 bytes at 16kHz) to match Asterisk's expected ptime.
   */
  sendAudio(channelId: string, pcm: Buffer): void {
    const session = this.sessions.get(channelId);
    if (!session?.remoteAddress || !session.remotePort) {
      log.warn(`[${channelId}] Cannot send audio — remote addr unknown`);
      return;
    }

    const FRAME_BYTES    = 640;  // 20ms @ 16kHz × 2 bytes/sample
    const SAMPLES_PER_FRAME = 320;

    for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
      const frame = pcm.subarray(offset, offset + FRAME_BYTES);
      const packet = buildRtpPacket(frame, session.txSeq, session.txTimestamp, 0xdeadbeef);

      this.socket.send(packet, session.remotePort, session.remoteAddress);

      session.txSeq       = (session.txSeq + 1) & 0xffff;
      session.txTimestamp = (session.txTimestamp + SAMPLES_PER_FRAME) >>> 0;
    }
  }

  private _onUdpMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    // Find session by matching incoming SSRC to latched SSRC, or assign to the first unlatched session
    const header = parseRtpHeader(msg);
    if (!header) return;

    let targetSession: CallSession | undefined;
    let targetId: string | undefined;

    for (const [id, session] of this.sessions) {
      if (session.ssrc === null) {
        // Latch first packet
        session.ssrc          = header.ssrc;
        session.remoteAddress = rinfo.address;
        session.remotePort    = rinfo.port;
        targetSession = session;
        targetId = id;
        log.debug(`[${id}] SSRC latched: 0x${header.ssrc.toString(16)}, remote ${rinfo.address}:${rinfo.port}`);
        break;
      } else if (session.ssrc === header.ssrc) {
        targetSession = session;
        targetId = id;
        break;
      }
    }

    if (!targetSession) return;

    const payload = msg.subarray(header.headerLength);
    if (payload.length === 0) return;

    targetSession.vad.feed(payload);
  }
}
