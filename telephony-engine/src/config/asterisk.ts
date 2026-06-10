import { config } from 'dotenv';
config();

export const ariConfig = {
  url:      process.env.ARI_URL      ?? 'http://127.0.0.1:8088',
  username: process.env.ARI_USERNAME ?? 'node-ari-user',
  password: process.env.ARI_PASSWORD ?? 'pass123',
  appName:  process.env.ARI_APP_NAME ?? 'telephony-engine',
} as const;
