import { config } from 'dotenv';
config();

// Ensure models are registered with Sequelize before sync
import './models/CallRecord.js';
import { createLogger } from './utils/logger.js';
import { initDatabase } from './config/database.js';
import { MediaServer } from './services/ari/media.js';
import { connectARI } from './services/ari/stasis.js';

const log = createLogger('Bootstrap');

async function bootstrap(): Promise<void> {
  log.info('Starting Real-Time Voice AI Bot');

  await initDatabase();

  const mediaServer = new MediaServer();
  await mediaServer.start();

  await connectARI(mediaServer);

  log.info('All services up — waiting for calls');
}

bootstrap().catch((err) => {
  console.error('[Bootstrap] Fatal error:', err);
  process.exit(1);
});
