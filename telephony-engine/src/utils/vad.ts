import { EventEmitter } from 'events';
import { rmsEnergy } from './audio-utils.js';

export interface VadOptions {
  /** RMS amplitude threshold to consider a frame as speech (default: 300) */
  speechThreshold?: number;
  /** Milliseconds of silence before emitting speech_end (default: 700) */
  silenceTimeoutMs?: number;
  /** Sample rate of the input PCM in Hz (default: 16000) */
  sampleRate?: number;
  /** Frame duration in ms, must evenly divide input chunks (default: 20) */
  frameDurationMs?: number;
}

type VadState = 'IDLE' | 'SPEAKING' | 'TRAILING';

/**
 * Energy-based Voice Activity Detector for slin16 (16-bit little-endian PCM).
 *
 * Events:
 *   'speech_start' — caller began speaking
 *   'speech_end'   — (buffer: Buffer) caller stopped; buffer contains all speech PCM
 */
export class VAD extends EventEmitter {
  private readonly speechThreshold: number;
  private readonly silenceTimeoutMs: number;
  private readonly sampleRate: number;
  private readonly frameSamples: number;

  private state: VadState = 'IDLE';
  private speechBuffer: Buffer[] = [];
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(options: VadOptions = {}) {
    super();
    this.speechThreshold  = options.speechThreshold  ?? 300;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? 700;
    this.sampleRate       = options.sampleRate       ?? 16000;
    const frameDurationMs = options.frameDurationMs  ?? 20;
    this.frameSamples     = Math.round(this.sampleRate * frameDurationMs / 1000);
  }

  feed(chunk: Buffer): void {
    const frameBytes = this.frameSamples * 2;
    // Process in frame-sized slices; leftover bytes are dropped (tiny at 20ms frames)
    for (let offset = 0; offset + frameBytes <= chunk.length; offset += frameBytes) {
      this._processFrame(chunk.subarray(offset, offset + frameBytes));
    }
  }

  reset(): void {
    this._clearSilenceTimer();
    this.state = 'IDLE';
    this.speechBuffer = [];
  }

  private _processFrame(frame: Buffer): void {
    const energy = rmsEnergy(frame);
    const isSpeech = energy >= this.speechThreshold;

    if (isSpeech) {
      if (this.state === 'IDLE') {
        this.state = 'SPEAKING';
        this.emit('speech_start');
      }
      if (this.state === 'SPEAKING' || this.state === 'TRAILING') {
        this._clearSilenceTimer();
        this.state = 'SPEAKING';
      }
      this.speechBuffer.push(frame);
    } else {
      if (this.state === 'SPEAKING') {
        this.state = 'TRAILING';
        this.speechBuffer.push(frame);
        this._startSilenceTimer();
      } else if (this.state === 'TRAILING') {
        this.speechBuffer.push(frame);
      }
    }
  }

  private _startSilenceTimer(): void {
    this._clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      if (this.state === 'TRAILING') {
        const buffer = Buffer.concat(this.speechBuffer);
        this.speechBuffer = [];
        this.state = 'IDLE';
        this.emit('speech_end', buffer);
      }
    }, this.silenceTimeoutMs);
  }

  private _clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
