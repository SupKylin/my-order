import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config, backendRoot } from './config.js';
import { db } from './models.js';
import { sessionMiddleware } from './auth.js';
import { imageDir } from './services/storage.js';
import { securityHeaders, validateRequestOrigin } from './middleware/security.js';
import { errorHandler } from './middleware/error-handler.js';
import { createApiRouter } from './routes/index.js';

/** 只负责装配应用，不承载具体业务；测试可创建独立实例而不占用固定端口。 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders());
  app.use(express.json({ limit: '2mb' }));
  app.use(
    '/uploads/images',
    express.static(imageDir, {
      maxAge: '30d',
      immutable: true,
      index: false,
      dotfiles: 'deny',
    }),
  );
  app.get('/api/health', async (req, res) => {
    await db.authenticate();
    res.json({ ok: true });
  });
  app.use('/api', sessionMiddleware(), validateRequestOrigin, createApiRouter());
  app.use('/api', (req, res) => res.status(404).json({ message: '接口不存在' }));

  // 生产环境由 Express 托管构建结果；开发环境仍由 Vite 提供页面。
  const frontendDist = path.resolve(backendRoot, '../frontend/dist');
  if (existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get('/{*path}', (req, res) => res.sendFile(path.join(frontendDist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}
