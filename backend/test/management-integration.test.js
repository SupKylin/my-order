import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import {
  db,
  User,
  Store,
  ImportTemplate,
  ImportJob,
  Upload,
  DictionaryOption,
  Order,
  OrderItem,
  Purchase,
  RiskAddress,
} from '../src/models.js';
import { WalmartSync, WalmartReceipt } from '../src/services/walmart/models.js';
import { listManagement } from '../src/services/management-list.js';
import { deleteManagement } from '../src/services/management-delete.js';
import { configureSync } from '../src/services/walmart/sync.js';
import { templatePayload } from '../src/services/templates.js';

// 删除类验证只允许一次性测试库，绝不清理业务库。
const isolated = /^my_order_management_test_\d+$/.test(config.db.database);
const test = (name, run) => baseTest(name, { skip: !isolated }, run);
let connection,
  created = false,
  actor;
const selection = (row) => ({ id: row.id, version: row.version, updatedAt: row.updatedAt });
const remove = async (resource, rows, extra = {}, as = actor) => {
  // 模拟列表读取后的版本（MySQL DATETIME 不保留创建实例的毫秒）。
  const stored = await Promise.all(rows.map((row) => (row.reload ? row.reload() : row)));
  return deleteManagement(resource, { rows: stored.map(selection), ...extra }, as);
};
before(async () => {
  if (!isolated) return;
  connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.username,
    password: config.db.password,
  });
  await connection.query(
    `CREATE DATABASE ${mysql.escapeId(config.db.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  );
  created = true;
  await db.sync();
  actor = await User.create({
    username: 'admin-test',
    displayName: '测试管理员',
    passwordHash: 'not-for-login',
    role: 'admin',
  });
});
after(async () => {
  await db.close();
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
});

test('分页、角色和启用筛选、北京时间日期边界、敏感字段及非法参数', async () => {
  await User.bulkCreate(
    Array.from({ length: 25 }, (_, i) => ({
      username: `member-${i}`,
      displayName: `成员 ${i}`,
      passwordHash: 'never-return',
      role: 'operations',
      active: i % 2 === 0,
      createdAt: new Date('2026-10-08T16:00:00Z'),
    })),
  );
  const first = await listManagement('users', { q: 'member-', page: '1' });
  const second = await listManagement('users', { q: 'member-', page: '2' });
  assert.equal(first.total, 25);
  assert.equal(first.rows.length, 20);
  assert.equal(second.rows.length, 5);
  assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.id)).size, 25);
  assert.ok(first.rows.every((row) => !('passwordHash' in row) && !('sessionVersion' in row)));
  assert.equal(
    (
      await listManagement('users', {
        q: 'member-',
        role: 'operations',
        active: 'true',
        startDate: '2026-10-09',
        endDate: '2026-10-09',
      })
    ).total,
    13,
  );
  assert.equal((await listManagement('users', { q: 'member-', endDate: '2026-10-08' })).total, 0);
  assert.equal((await listManagement('users', { q: '%' })).total, 0);
  for (const query of [
    { page: '0' },
    { pageSize: '100000' },
    { active: 'invalid' },
    { startDate: '2026-02-30' },
    { startDate: '2026-10-09', endDate: '2026-10-08' },
  ])
    await assert.rejects(listManagement('users', query));
  await assert.rejects(listManagement('unknown'));
});

test('导入历史超过100条可分页，按文件名和状态筛选', async () => {
  const upload = await Upload.create({
    id: randomUUID(),
    filename: 'test.xlsx',
    originalName: '采购结果.xlsx',
    kind: 'excel',
  });
  await ImportJob.bulkCreate(
    Array.from({ length: 105 }, (_, i) => ({
      id: randomUUID(),
      uploadId: upload.id,
      templateSnapshot: {},
      rows: [],
      errors: [],
      warnings: [],
      createdBy: actor.id,
      status: i === 0 ? 'completed' : 'preview',
    })),
  );
  const page = await listManagement('imports', { q: '采购结果', page: '6' });
  assert.equal(page.total, 105);
  assert.equal(page.rows.length, 5);
  assert.ok(page.rows.every((row) => row.filename === '采购结果.xlsx' && !('rows' in row)));
  assert.equal((await listManagement('imports', { status: 'completed' })).total, 1);
  const job = await ImportJob.findOne();
  await remove('imports', [job]);
  assert.equal(await ImportJob.count(), 104);
  assert.equal(await Upload.count(), 1);
});

test('账号删除保护当前账号、最后一个总账号，批量请求失败不部分删除', async () => {
  const member = await User.findOne({ where: { username: 'member-0' } });
  await assert.rejects(remove('users', [member, actor]), /当前登录/);
  await assert.rejects(remove('users', [actor], {}, member), /至少一个/);
  assert.ok(await User.findByPk(member.id));
  const secondAdmin = await User.create({
    username: 'second-admin',
    displayName: '备用',
    passwordHash: 'test',
    role: 'admin',
  });
  await remove('users', [member, secondAdmin]);
  assert.equal(await User.findByPk(member.id), null);
  assert.ok(await User.findByPk(actor.id));
});

test('模板绑定保护、字典隔离和版本保护，历史订单采购数据保留', async () => {
  const channel = await DictionaryOption.create({ kind: 'purchaseChannel', value: '保护渠道' });
  const template = await ImportTemplate.create({
    name: '测试模板',
    sheetName: 'Sheet1',
    headerRow: 1,
    mappings: [],
    purchaseChannelId: channel.id,
  });
  const order = await Order.create({ orderNumber: 'KEEP-ORDER' });
  const item = await OrderItem.create({
    orderId: order.id,
    purchaseChannelKey: 'test',
    shopName: '历史店铺',
  });
  await Purchase.create({ itemId: item.id, purchaseChannel: ['保护渠道'] });
  await assert.rejects(remove('dictionaries', [channel], { kind: 'purchaseChannel' }), /模板/);
  await assert.rejects(remove('dictionaries', [channel], { kind: 'purchasePlatform' }), /已删除/);
  await remove('templates', [template]);
  const stale = selection(channel);
  await channel.update({ version: channel.version + 1, value: '改名渠道' });
  await assert.rejects(
    deleteManagement('dictionaries', { kind: 'purchaseChannel', rows: [stale] }, actor),
    /已被修改/,
  );
  await channel.reload();
  await remove('dictionaries', [channel], { kind: 'purchaseChannel' });
  assert.equal(await Order.count(), 1);
  assert.equal(await OrderItem.count(), 1);
  assert.deepEqual((await Purchase.findOne()).purchaseChannel, ['保护渠道']);
  await assert.rejects(
    templatePayload({
      name: '绑定已删',
      sheetName: 'Sheet1',
      headerRow: 1,
      mappings: [{ column: 1, header: '订单号', field: 'orderNumber' }],
      purchaseChannelId: channel.id,
    }),
    /已停用或不存在/,
  );
});

test('店铺删除与同步命名锁互斥，成功删除关闭调度且保留订单和回执', async () => {
  const store = await Store.create({
    // 命名锁跨数据库共享，测试使用独立 ID 段，避免占用本地业务店铺锁。
    id: 1000000000 + Math.floor(Date.now() % 1000000000),
    walmartStoreName: 'W',
    systemStoreName: 'S',
    clientId: 'test',
    clientSecret: 'test',
  });
  const other = await Store.create({
    id: store.id + 1,
    walmartStoreName: 'W2',
    systemStoreName: 'S2',
    clientId: 'test',
    clientSecret: 'test',
  });
  await configureSync(store.id, true, actor);
  await WalmartReceipt.create({
    storeId: store.id,
    purchaseOrderId: 'PO',
    customerOrderId: 'CO',
    raw: {},
  });
  assert.equal((await listManagement('stores', { enabled: 'true' })).total, 1);
  assert.equal((await listManagement('stores', { enabled: 'false' })).total, 1);
  const lock = await db.connectionManager.getConnection();
  try {
    await lock.promise().query('SELECT GET_LOCK(?, 0)', [`walmart-sync:${store.id}`]);
    await assert.rejects(remove('stores', [other, store]), /正在同步/);
    assert.equal(await Store.count(), 2);
  } finally {
    await lock.promise().query('SELECT RELEASE_LOCK(?)', [`walmart-sync:${store.id}`]);
    await db.connectionManager.releaseConnection(lock);
  }
  await remove('stores', [store, other]);
  assert.equal(await Store.count(), 0);
  assert.equal(await WalmartSync.count(), 0);
  assert.equal(await WalmartReceipt.count(), 1);
  assert.equal(await Order.count(), 1);
  assert.equal(await Purchase.count(), 1);
  await assert.rejects(configureSync(store.id, true, actor), /不存在/);
});

test('风险地址按关键词筛选与批量删除', async () => {
  const address = await RiskAddress.create({
    address1: 'Test Rd',
    city: 'City',
    state: 'CA',
    postalCode: '10000',
    addressKey: 'test-key',
    note: '验证备注',
  });
  const result = await listManagement('risk-addresses', { q: '验证备注' });
  assert.equal(result.total, 1);
  await remove('risk-addresses', result.rows);
  assert.equal(await RiskAddress.findByPk(address.id), null);
});
