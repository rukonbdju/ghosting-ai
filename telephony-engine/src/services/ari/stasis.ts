import * as ari from 'ari-client';
import { ariConfig } from '../../config/asterisk.js';
import {
  setCallState,
  setCallMetrics,
  getCallMetrics,
  appendHistory,
  getHistory,
  deleteCallData,
  CallState,
} from '../../config/redis.js';
import { transcribe } from '../ai/stt.js';
import { streamResponse } from '../ai/llm.js';
import { synthesize } from '../ai/tts.js';
import { MediaServer } from './media.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Stasis');
const LLM_MODEL = process.env.LLM_MODEL ?? 'llama3.2';

type AriClient = ari.Client;

async function handleCall(client: AriClient, channel: ari.Channel, mediaServer: MediaServer): Promise<void> {
  const channelId = channel.id;
  const callerId = channel.caller?.number ?? 'unknown';
  const startTime = new Date();

  log.info(`[${channelId}] Handling new call from ${callerId}`);

  // Teardown helper — idempotent
  let tornDown = false;
  async function teardown(bridge?: ari.Bridge, externalChannel?: ari.Channel): Promise<void> {
    if (tornDown) return;
    tornDown = true;
    log.info(`[${channelId}] Tearing down call`);

    mediaServer.deregisterCall(channelId);

    await externalChannel?.hangup().catch(() => { /* already gone */ });
    await bridge?.destroy().catch(() => { /* already gone */ });
    await channel.hangup().catch(() => { /* already gone */ });

    await saveCallRecord(channelId, callerId, startTime);
    await deleteCallData(channelId);
  }

  // --- State 100: Answer ---
  try {
    await channel.answer();
    log.info(`[${channelId}] Channel answered`);
  } catch (err) {
    log.error(`[${channelId}] Failed to answer: ${(err as Error).message}`);
    return;
  }

  await setCallState(channelId, 'idle');
  await setCallMetrics(channelId, {
    callerId,
    startTime: startTime.toISOString(),
  });
  await appendHistory(channelId, 'system', process.env.LLM_SYSTEM_PROMPT
    ?? 'You are a helpful phone assistant. Keep your responses concise and conversational.');

  // --- State 200: Create mixing bridge ---
  let bridge: ari.Bridge;
  try {
    bridge = client.Bridge();
    await bridge.create({ type: 'mixing' });
    await bridge.addChannel({ channel: channelId });
    log.info(`[${channelId}] Bridge created and caller added`);
  } catch (err) {
    log.error(`[${channelId}] Bridge creation failed: ${(err as Error).message}`);
    await teardown();
    return;
  }

  // --- State 300: Create ExternalMedia channel (slin16 → UDP 9999) ---
  let externalChannel: ari.Channel;
  try {
    externalChannel = await client.channels.externalMedia({
      app: ariConfig.appName,
      external_host: `${process.env.MEDIA_HOST ?? '127.0.0.1'}:${process.env.MEDIA_PORT ?? '9999'}`,
      format: 'slin16',
    });
    await bridge.addChannel({ channel: externalChannel.id });
    log.info(`[${channelId}] ExternalMedia channel created: ${externalChannel.id}`);
  } catch (err) {
    log.error(`[${channelId}] ExternalMedia creation failed: ${(err as Error).message}`);
    await teardown(bridge);
    return;
  }

  // --- State 400: Register with media server and start AI pipeline loop ---
  mediaServer.registerCall(channelId, async (pcm: Buffer) => {
    if (tornDown) return;

    try {
      await runAiPipeline(channelId, pcm, mediaServer, () => tornDown);
    } catch (err) {
      log.error(`[${channelId}] AI pipeline error: ${(err as Error).message}`);
    }
  });

  // --- State 500: Teardown on hangup ---
  channel.on('StasisEnd', () => teardown(bridge, externalChannel));
  channel.on('ChannelDestroyed', () => teardown(bridge, externalChannel));
  externalChannel.on('ChannelDestroyed', () => {
    // ExternalMedia gone unexpectedly — tear down the call
    teardown(bridge);
  });
}

async function runAiPipeline(
  channelId: string,
  pcm: Buffer,
  mediaServer: MediaServer,
  isTornDown: () => boolean,
): Promise<void> {
  // STT
  await setCallState(channelId, 'processing_stt');
  const text = await transcribe(pcm);
  if (!text) {
    await setCallState(channelId, 'idle');
    return;
  }

  await appendHistory(channelId, 'user', text);

  // LLM → TTS (sentence-by-sentence streaming)
  await setCallState(channelId, 'processing_llm');
  const history = await getHistory(channelId);

  let fullReply = '';
  fullReply = await streamResponse(history, async (sentence: string) => {
    if (isTornDown()) return;
    await setCallState(channelId, 'processing_tts');
    const audio = await synthesize(sentence);
    if (audio.length > 0 && !isTornDown()) {
      await setCallState(channelId, 'speaking');
      mediaServer.sendAudio(channelId, audio);
    }
  });

  if (fullReply) {
    await appendHistory(channelId, 'assistant', fullReply);
  }

  await setCallState(channelId, 'idle');
}

async function saveCallRecord(channelId: string, callerId: string, startTime: Date): Promise<void> {
  const endTime = new Date();
  const durationSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000);

  try {
    const metrics = await getCallMetrics(channelId);
    const history = await getHistory(channelId);
    // Strip the system prompt from the saved transcript
    const conversation = history.filter((m) => m.role !== 'system');
    console.log({
      channelId,
      callerId: metrics?.callerId ?? callerId,
      startTime,
      endTime,
      durationSeconds,
      transcript: JSON.stringify(conversation),
      llmModel: LLM_MODEL,
    })
    /* await CallRecord.create({
      channelId,
      callerId: metrics?.callerId ?? callerId,
      startTime,
      endTime,
      durationSeconds,
      transcript: JSON.stringify(conversation),
      llmModel:   LLM_MODEL,
    }); */

    log.info(`[${channelId}] Call record saved (${durationSeconds}s, ${conversation.length} turns)`);
  } catch (err) {
    log.warn(`[${channelId}] Could not save call record: ${(err as Error).message}`);
  }
}

export async function connectARI(mediaServer: MediaServer): Promise<void> {
  log.info(`Connecting to Asterisk ARI at ${ariConfig.url}`);

  const client = await ari.connect(ariConfig.url, ariConfig.username, ariConfig.password);

  client.on('StasisStart', (event: ari.StasisStart, channel: ari.Channel) => {
    // Filter out ExternalMedia channels — they appear as StasisStart too
    if (
      channel.name?.startsWith('UnicastRTP') ||
      channel.name?.startsWith('ExternalMedia') ||
      event.args?.includes('external_media')
    ) {
      return;
    }

    handleCall(client, channel, mediaServer).catch((err) => {
      log.error(`Unhandled error in handleCall: ${(err as Error).message}`);
    });
  });

  client.start(ariConfig.appName);
  log.info(`ARI Stasis application '${ariConfig.appName}' started`);
}
