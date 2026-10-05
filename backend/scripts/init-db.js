import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import { db, User } from '../src/models.js';
import { hashPassword } from '../src/auth.js';
import { ensureStorage } from '../src/services/storage.js';
import { migrateDictionaries, migrateOrderFields } from '../src/migrations.js';
const reset = process.argv.includes('--reset');
try {
  if (config.db.database !== 'my_order') throw new Error('初始化程序只允许操作 my_order 数据库');
  if (reset && !process.argv.includes('--confirm=my_order'))
    throw new Error('重置需显式提供 --reset --confirm=my_order');
  if (!config.secret || config.secret.length < 32)
    throw new Error('请配置至少 32 字符的 SESSION_SECRET');
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 8)
    throw new Error('请在 .env 配置至少 8 字符的 ADMIN_PASSWORD');
  const c = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.username,
    password: config.db.password,
  });
  await c.query(
    'CREATE DATABASE IF NOT EXISTS `my_order` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
  );
  const [tables] = await c.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    ['my_order'],
  );
  console.log(`目标数据库 my_order，当前 ${tables.length} 张表。`);
  if (reset) {
    await c.query('DROP DATABASE `my_order`');
    await c.query('CREATE DATABASE `my_order` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    console.log('已按明确指令清空 my_order。');
  }
  await c.end();
  await db.sync();
  await migrateDictionaries();
  await migrateOrderFields();
  const username = process.env.ADMIN_USERNAME || 'admin';
  if (!(await User.findOne({ where: { username } })))
    await User.create({
      username,
      displayName: '系统管理员',
      role: 'admin',
      passwordHash: await hashPassword(process.env.ADMIN_PASSWORD),
    });
  await ensureStorage();
  console.log('数据库初始化完成；管理员密码保存在本地配置中。');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
