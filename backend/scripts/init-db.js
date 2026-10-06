import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import { db, User } from '../src/models.js';
import { hashPassword } from '../src/auth.js';
import { ensureStorage } from '../src/services/storage.js';
import { migrateDictionaries, migrateOrderFields } from '../src/migrations.js';
const reset = process.argv.includes('--reset');
const database = config.db.database;
let connection;
try {
  if (
    !database ||
    database.length > 64 ||
    ['mysql', 'information_schema', 'performance_schema', 'sys'].includes(database.toLowerCase())
  )
    throw new Error('请配置有效的业务数据库 DB_NAME');
  if (reset && !process.argv.includes(`--confirm=${database}`))
    throw new Error(`重置需显式提供 --reset --confirm=${database}`);
  if (!config.secret || config.secret.length < 32)
    throw new Error('请配置至少 32 字符的 SESSION_SECRET');
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 8)
    throw new Error('请在 .env 配置至少 8 字符的 ADMIN_PASSWORD');
  const connectionOptions = {
    host: config.db.host,
    port: config.db.port,
    user: config.db.username,
    password: config.db.password,
  };
  const databaseIdentifier = mysql.escapeId(database);
  try {
    // 宝塔通常已创建数据库；直接连接，避免要求应用账号拥有建库权限。
    connection = await mysql.createConnection({ ...connectionOptions, database });
  } catch (error) {
    if (error.code !== 'ER_BAD_DB_ERROR') throw error;
    connection = await mysql.createConnection(connectionOptions);
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS ${databaseIdentifier} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    );
  }
  const [tables] = await connection.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [database],
  );
  console.log(`目标数据库 ${database}，当前 ${tables.length} 张表。`);
  if (reset) {
    await connection.query(`DROP DATABASE ${databaseIdentifier}`);
    await connection.query(
      `CREATE DATABASE ${databaseIdentifier} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    );
    console.log(`已按明确指令清空 ${database}。`);
  }
  await connection.end();
  connection = null;
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
  if (connection) await connection.end();
  await db.close();
}
