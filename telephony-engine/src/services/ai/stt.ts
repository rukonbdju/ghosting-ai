import { config } from 'dotenv';
config();
import FormData from 'form-data';
import { buildWavBuffer } from '../../utils/audio-utils.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('STT');
const STT_URL = process.env.STT_URL ?? 'http://localhost:8178/inference';

interface WhisperResponse {
  text: string;
}

/**
 * Transcribes raw slin16 PCM audio using the local Whisper.cpp HTTP server.
 * Returns empty string if the server is unreachable or returns an error.
 */
export async function transcribe(pcmBuffer: Buffer): Promise<string> {
  if (pcmBuffer.length === 0) return '';

  const wav = buildWavBuffer(pcmBuffer);
  const form = new FormData();
  form.append('file', wav, { filename: 'audio.wav', contentType: 'audio/wav' });
  form.append('response_format', 'json');

  log.debug(`Sending ${(wav.length / 1024).toFixed(1)} KB WAV to Whisper`);

  const res = await fetch(STT_URL, {
    method:  'POST',
    // @ts-ignore — FormData from 'form-data' package; headers compatible
    headers: form.getHeaders(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body:    form as any,
  });

  if (!res.ok) {
    log.error(`Whisper returned HTTP ${res.status}`);
    return '';
  }

  const json = (await res.json()) as WhisperResponse;
  const text = (json.text ?? '').trim();
  log.info(`STT result: "${text}"`);
  return text;
}
