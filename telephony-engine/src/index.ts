import { config } from 'dotenv';
config();

import { createLogger } from './utils/logger.js';
import { MediaServer } from './services/ari/media.js';
import { connectARI } from './services/ari/stasis.js';

const log = createLogger('Bootstrap');

async function bootstrap(): Promise<void> {
  log.info('Starting Real-Time Voice AI Bot');

  const mediaServer = new MediaServer();
  await mediaServer.start();

  await connectARI(mediaServer);

  log.info('All services up — waiting for calls');
}

bootstrap().catch((err) => {
  console.error('[Bootstrap] Fatal error:', err);
  process.exit(1);
});
