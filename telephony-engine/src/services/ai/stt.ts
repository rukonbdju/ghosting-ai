import { config } from 'dotenv';
config();
import { writeFileSync } from 'fs';
import { buildWavBuffer } from '../../utils/audio-utils.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('STT');
const STT_URL          = process.env.STT_URL           ?? 'http://localhost:8178/inference';
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE  ?? 'en';
const SAVE_DEBUG_AUDIO = process.env.SAVE_DEBUG_AUDIO  === 'true';

interface WhisperResponse {
  text: string;
}

export async function transcribe(pcmBuffer: Buffer): Promise<string> {
  if (pcmBuffer.length === 0) return '';

  const wav = buildWavBuffer(pcmBuffer);
  log.debug(`Sending ${(wav.length / 1024).toFixed(1)} KB WAV to Whisper`);

  if (SAVE_DEBUG_AUDIO) {
    const fname = `/tmp/debug_speech_${Date.now()}.wav`;
    writeFileSync(fname, wav);
    log.info(`Debug WAV saved: ${fname}`);
  }

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('language', WHISPER_LANGUAGE);
  form.append('temperature', '0');
  form.append('task', 'transcribe');

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
