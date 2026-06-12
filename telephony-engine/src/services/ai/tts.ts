import { config } from 'dotenv';
config();
import { spawn } from 'child_process';
import { resampleSlin16 } from '../../utils/audio-utils.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('TTS');
const PIPER_BIN         = process.env.PIPER_BIN         ?? 'piper';
const PIPER_MODEL       = process.env.PIPER_MODEL       ?? '/opt/piper/models/en_US-lessac-medium.onnx';
const PIPER_SAMPLE_RATE = parseInt(process.env.PIPER_SAMPLE_RATE ?? '22050', 10);

/**
 * Synthesizes `text` using Piper TTS.
 * Returns raw 16kHz mono 16-bit little-endian PCM (slin16).
 */
export function synthesize(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!text.trim()) {
      resolve(Buffer.alloc(0));
      return;
    }

    log.debug(`Synthesizing: "${text}"`);

    const piper = spawn(PIPER_BIN, [
      '--model',       PIPER_MODEL,
      '--output-raw',
      '--quiet',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];

    piper.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    piper.stderr.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) log.debug(`piper stderr: ${msg}`);
    });

    piper.on('error', (err) => {
      log.error(`Piper process error: ${err.message}`);
      reject(err);
    });

    piper.on('close', (code) => {
      if (code !== 0) {
        log.warn(`Piper exited with code ${code}`);
      }
      let pcm = Buffer.concat(chunks);
      if (PIPER_SAMPLE_RATE !== 16000) {
        pcm = resampleSlin16(pcm, PIPER_SAMPLE_RATE, 16000);
      }
      log.debug(`TTS produced ${pcm.length} bytes of PCM (resampled to 16kHz)`);
      resolve(pcm);
    });

    // Write text to stdin and close it so Piper starts processing
    piper.stdin.write(text, 'utf8');
    piper.stdin.end();
  });
}
