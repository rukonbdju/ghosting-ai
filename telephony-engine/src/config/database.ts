import { config } from 'dotenv';
config();
import { Sequelize } from 'sequelize';
import { createLogger } from '../utils/logger.js';

const log = createLogger('DB');

export const sequelize = new Sequelize({
  dialect:  'mysql',
  host:     process.env.DB_HOST ?? '127.0.0.1',
  port:     parseInt(process.env.DB_PORT ?? '3306', 10),
  database: process.env.DB_NAME ?? 'ghosting_ai',
  username: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASS ?? '',
  logging:  false,
});

export async function initDatabase(): Promise<void> {
  try {
    await sequelize.authenticate();
    log.info('MariaDB connection established');
    await sequelize.sync({ alter: false });
    log.info('Models synchronized');
  } catch (err) {
    log.warn(`MariaDB unavailable — post-call records will be skipped: ${(err as Error).message}`);
  }
}
