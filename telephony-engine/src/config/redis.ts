import { config } from 'dotenv';
config();
import { Redis } from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

redis.on('error', (err: Error) => console.error('[Redis] Connection error:', err.message));

export type CallState = 'idle' | 'listening' | 'processing_stt' | 'processing_llm' | 'processing_tts' | 'speaking';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function setCallState(channelId: string, state: CallState): Promise<void> {
  await redis.set(`call:${channelId}:state`, state);
}

export async function setCallMetrics(channelId: string, data: Record<string, string>): Promise<void> {
  await redis.hset(`call:${channelId}:metrics`, data);
}

export async function getCallMetrics(channelId: string): Promise<Record<string, string>> {
  return redis.hgetall(`call:${channelId}:metrics`);
}

export async function appendHistory(channelId: string, role: ChatMessage['role'], content: string): Promise<void> {
  const entry = JSON.stringify({ role, content });
  await redis.rpush(`call:${channelId}:history`, entry);
}

export async function getHistory(channelId: string): Promise<ChatMessage[]> {
  const entries = await redis.lrange(`call:${channelId}:history`, 0, -1);
  return entries.map((e: string) => JSON.parse(e) as ChatMessage);
}

export async function deleteCallData(channelId: string): Promise<void> {
  const keys = await redis.keys(`call:${channelId}:*`);
  if (keys.length > 0) await redis.del(...keys);
}
