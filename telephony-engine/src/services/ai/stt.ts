import { config } from 'dotenv';
config();
import { buildWavBuffer } from '../../utils/audio-utils.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('STT');
const STT_URL = process.env.STT_URL ?? 'http://localhost:8178/inference';

interface WhisperResponse {
  text: string;
}

export async function transcribe(pcmBuffer: Buffer): Promise<string> {
  if (pcmBuffer.length === 0) return '';

  const wav = buildWavBuffer(pcmBuffer);
  log.debug(`Sending ${(wav.length / 1024).toFixed(1)} KB WAV to Whisper`);

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');

  const res = await fetch(STT_URL, { method: 'POST', body: form });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log.error(`Whisper returned HTTP ${res.status}: ${body}`);
    return '';
  }

  const json = (await res.json()) as WhisperResponse;
  const text = (json.text ?? '').trim();
  log.info(`STT result: "${text}"`);
  return text;
}
