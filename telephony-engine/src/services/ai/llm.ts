import { config } from 'dotenv';
config();
import { createLogger } from '../../utils/logger.js';
import type { ChatMessage } from '../../config/redis.js';

const log = createLogger('LLM');
const LLM_URL    = process.env.LLM_URL    ?? 'http://localhost:11434/api/chat';
const LLM_MODEL  = process.env.LLM_MODEL  ?? 'llama3.2';
const SYSTEM_PROMPT = process.env.LLM_SYSTEM_PROMPT
  ?? 'You are a helpful phone assistant. Keep your responses concise and conversational.';

const SENTENCE_END = /[.?!]+\s*/;

interface OllamaChunk {
  message?: { content?: string };
  done: boolean;
}

/**
 * Streams a response from Ollama, invoking `onSentence` for each complete sentence
 * so TTS can begin generating audio immediately without waiting for the full response.
 *
 * Returns the complete assistant response text.
 */
export async function streamResponse(
  history: ChatMessage[],
  onSentence: (sentence: string) => Promise<void>,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
  ];

  log.debug(`Sending ${messages.length} messages to ${LLM_MODEL}`);

  const res = await fetch(LLM_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: LLM_MODEL, messages, stream: true }),
  });

  if (!res.ok || !res.body) {
    log.error(`LLM returned HTTP ${res.status}`);
    return '';
  }

  const decoder  = new TextDecoder();
  const reader   = res.body.getReader();
  let pending    = '';
  let fullReply  = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value, { stream: true }).split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let chunk: OllamaChunk;
      try {
        chunk = JSON.parse(line) as OllamaChunk;
      } catch {
        continue;
      }

      const token = chunk.message?.content ?? '';
      pending   += token;
      fullReply += token;

      // Flush complete sentences to TTS immediately
      let match: RegExpExecArray | null;
      while ((match = SENTENCE_END.exec(pending)) !== null) {
        const sentence = pending.slice(0, match.index + match[0].length).trim();
        pending = pending.slice(match.index + match[0].length);
        if (sentence) {
          log.debug(`LLM sentence: "${sentence}"`);
          await onSentence(sentence);
        }
      }

      if (chunk.done) break;
    }
  }

  // Flush any remaining text that didn't end with punctuation
  if (pending.trim()) {
    log.debug(`LLM trailing text: "${pending.trim()}"`);
    await onSentence(pending.trim());
  }

  log.info(`LLM full reply: "${fullReply.trim()}"`);
  return fullReply.trim();
}
