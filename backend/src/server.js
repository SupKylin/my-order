import { config } from './config.js';
import { db, Session } from './models.js';
import { Op } from 'sequelize';
import { ensureStorage } from './services/storage.js';
import { createApp } from './app.js';
import { startWalmartScheduler } from './services/walmart/sync.js';
import { startThumbnailWarmer } from './services/thumbnail-warmer.js';
import { startAuditCleanup } from './services/audit.js';
import { startHomeScheduler } from './services/home/index.js';
try {
  if (config.secret.length < 32) throw new Error('请先配置 .env 中的 SESSION_SECRET');
  await db.authenticate();
  await Session.count();
  await ensureStorage();
  const server = createApp().listen(config.port, config.host, () =>
    console.log(`订单系统后端已启动：http://${config.host}:${config.port}`),
  );
  // 允许大文件在慢速网络上传输，保留有限的请求时长。
  server.requestTimeout = 2 * 60 * 60 * 1000;
  const cleanup = setInterval(
    () =>
      Session.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } }).catch((e) =>
        console.error('会话清理失败', e.message),
      ),
    60 * 60 * 1000,
  );
  cleanup.unref();
  const stopWalmart = startWalmartScheduler();
  const stopThumbnails = startThumbnailWarmer();
  const stopAudit = startAuditCleanup();
  const stopHome = startHomeScheduler();
  const stop = () =>
    server.close(async () => {
      clearInterval(cleanup);
      await stopWalmart();
      await stopThumbnails();
      await stopAudit();
      await stopHome();
      await db.close();
      process.exit(0);
    });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (e) {
  console.error('启动失败：', e.message);
  await db.close();
  process.exitCode = 1;
}
