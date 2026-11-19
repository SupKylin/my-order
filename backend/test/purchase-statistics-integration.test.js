import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { once } from 'node:events';
import { config } from '../src/config.js';
import { db, Store, Order, OrderItem, Purchase, User } from '../src/models.js';
import {
  migratePurchaseStatistics,
  PurchaseStatisticsSnapshot,
  PurchaseStatisticsGroup,
} from '../src/services/purchase-statistics/model.js';
import {
  capturePurchaseStatistics,
  readPurchaseStatistics,
} from '../src/services/purchase-statistics/index.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
const isolated = /^my_order_purchase_statistics_test_\d+$/.test(config.db.database);
const test = (name, fn) => baseTest(name, { skip: !isolated }, fn);
let connection,
  created = false,
  server,
  base;
const users = {},
  items = [],
  boundary = Date.parse('2026-11-17T00:00:00+08:00');
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
  await migratePurchaseStatistics();
  await migratePurchaseStatistics();
  const passwordHash = await hashPassword('Stats-test-123');
  for (const role of ['admin', 'supervisor', 'purchasing', 'operations'])
    users[role] = await User.create({ username: role, displayName: role, role, passwordHash });
  await Store.bulkCreate([
    { systemStoreName: 'A', walmartStoreName: 'A', ownerId: users.operations.id },
    { systemStoreName: 'B', walmartStoreName: 'B' },
  ]);
  const order = await Order.create({ orderNumber: 'SAME-ORDER' });
  for (const [shop, status, channels, fulfillmentParty, platformOrderStatus] of [
    ['A', '采购中', ['甲', '乙'], 'SellerFulfilled', '已确认'],
    ['A', '采购成功（已发货无单号）', ['甲'], 'SellerFulfilled', '已发货'],
    ['B', '采购成功（砍单）', ['乙'], 'SellerFulfilled', '已确认'],
    ['B', null, null, 'SellerFulfilled', '待确认'],
    ['B', '取消采购', [], 'SellerFulfilled', '已确认'],
    ['A', '采购中', ['甲'], ' WFSFulfilled ', '已确认'],
    ['A', '采购中', ['甲'], 'SellerFulfilled', '已取消'],
  ]) {
    const item = await OrderItem.create({
      orderId: order.id,
      shopName: shop,
      walmartSku: `SKU-${items.length}`,
      purchaseChannelKey: 'test',
      fulfillmentParty,
      platformOrderStatus,
    });
    await Purchase.create({ itemId: item.id, purchaseStatus: status, purchaseChannel: channels });
    items.push(item);
  }
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
  if (connection) {
    if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
    await connection.end();
  }
});

test('真实数据库聚合排除WFS/平台取消，渠道并集与整体去重，迁移幂等', async () => {
  await Promise.all([
    capturePurchaseStatistics({ scheduledAt: boundary, now: boundary }),
    capturePurchaseStatistics({ scheduledAt: boundary, now: boundary }),
  ]);
  assert.equal(await PurchaseStatisticsSnapshot.count(), 1);
  const r = await readPurchaseStatistics({}, users.admin, boundary);
  assert.equal(r.summary.total, 5);
  assert.equal(r.summary.unassigned, 2);
  assert.equal(r.summary.unassignedRate, 40);
  assert.equal(r.summary.success, 1);
  assert.equal(r.summary.failed, 1);
  assert.equal(r.summary.inProgress, 1);
  assert.equal(r.summary.other, 2);
  assert.equal(r.rows.find((x) => x.channel === '甲').total, 2);
  assert.equal(r.rows.find((x) => x.channel === '乙').total, 2);
  await migratePurchaseStatistics();
  assert.equal(await PurchaseStatisticsSnapshot.count(), 1);
});
test('历史固定、权限跟随当前所属店铺、渠道不影响顶部、无权限数据不泄露', async () => {
  await Purchase.update(
    { purchaseStatus: '采购失败', purchaseChannel: ['丙'] },
    { where: { itemId: items[0].id } },
  );
  await capturePurchaseStatistics({ scheduledAt: boundary, now: boundary + 3600000 });
  const ops = await readPurchaseStatistics({ channels: ['乙'] }, users.operations, boundary);
  assert.equal(ops.summary.total, 2);
  assert.equal(ops.summary.inProgress, 1);
  assert.equal(ops.rows.length, 1);
  assert.equal(ops.rows[0].total, 1);
  const admin = await readPurchaseStatistics({ channels: ['不存在'] }, users.admin, boundary);
  assert.equal(admin.summary.total, 5);
  assert.equal(admin.total, 0);
  await Store.update({ ownerId: null }, { where: { systemStoreName: 'A' } });
  const none = await readPurchaseStatistics({}, users.operations, boundary);
  assert.equal(none.summary.total, 0);
  assert.deepEqual(none.channels, []);
  await Store.update({ ownerId: users.operations.id }, { where: { systemStoreName: 'A' } });
});
test('失败整期回滚可重试、跨日只取最新整体、不补造多日前数据', async (t) => {
  const next = boundary + 86400000;
  const mock = t.mock.method(PurchaseStatisticsGroup, 'bulkCreate', async () => {
    throw Error('模拟写入失败');
  });
  await assert.rejects(capturePurchaseStatistics({ scheduledAt: next, now: next }), /模拟写入失败/);
  assert.equal(await PurchaseStatisticsSnapshot.count(), 1);
  mock.mock.restore();
  await capturePurchaseStatistics({ scheduledAt: next, now: next + 60000 });
  const r = await readPurchaseStatistics({}, users.admin, next + 60000);
  assert.equal(r.snapshotCount, 2);
  assert.equal(r.summary.total, 5);
  assert.equal(r.summary.failed, 2);
  assert.equal(r.summary.date, '2026-11-17');
  assert.equal(await PurchaseStatisticsSnapshot.count(), 2);
  assert.deepEqual(
    await capturePurchaseStatistics({ scheduledAt: boundary - 86400000, now: next }),
    { skipped: true },
  );
});
test('真实HTTP四角色只读权限、未登录拒绝、渠道与非法日期参数', async () => {
  assert.equal((await fetch(base + '/purchase-statistics')).status, 401);
  for (const role of Object.keys(users)) {
    const login = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ username: role, password: 'Stats-test-123' }),
    });
    assert.equal(login.status, 200);
    const data = await login.json(),
      cookie = login.headers.get('set-cookie').split(';')[0];
    // 测试快照日期是未来；按服务端当前日期只测空范围及校验，服务层已覆盖快照权限。
    const r = await fetch(base + '/purchase-statistics', { headers: { cookie } });
    assert.equal(r.status, 200);
    const bad = await fetch(base + '/purchase-statistics?startDate=2026-02-30', {
      headers: { cookie },
    });
    assert.equal(bad.status, 400);
    const write = await fetch(base + '/purchase-statistics', {
      method: 'POST',
      headers: {
        cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': data.csrfToken,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: '{}',
    });
    assert.equal(write.status, 404);
  }
});
