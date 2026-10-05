import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });
export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'my_order',
    username: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  },
  secret: process.env.SESSION_SECRET || '',
  publicBase: (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  origins: (process.env.APP_ORIGIN || 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((s) => s.trim()),
  secure: process.env.COOKIE_SECURE === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
  storage: path.join(backendRoot, 'storage'),
  sessionMs: 7 * 24 * 60 * 60 * 1000,
};
