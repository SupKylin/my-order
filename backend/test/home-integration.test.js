import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import { db, User, Store, Order, OrderItem, Purchase, AuditLog } from '../src/models.js';
import { StoreSnapshot, migrateHome } from '../src/services/home/model.js';
import { updateStoreSnapshot, readHome, refreshHomeSnapshots } from '../src/services/home/index.js';
import { REMOTE_METRICS } from '../src/services/home/remote.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { WalmartReceipt } from '../src/services/walmart/models.js';
import { WalmartClient } from '../src/services/walmart/client.js';

// 只允许显式指定的一次性测试库，禁止测试清理业务数据库。
const isolated = /^my_order_home_test_[0-9]+$/.test(config.db.database);
const test = (name, run) => baseTest(name, { skip: !isolated }, run);
let connection,
  created = false,
  server,
  base;
const users = {},
  stores = {},
  cookies = {};
const now = Date.parse('2026-10-19T00:00:00-08:00');
const remote = Object.fromEntries(
  Object.keys(REMOTE_METRICS).map((key) => [
    key,
    { status: 'ok', value: 10, fetchedAt: new Date(now).toISOString() },
  ]),
);
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
  await migrateHome();
  await migrateHome();
  const passwordHash = await hashPassword('Home-test-123');
  for (const role of ['admin', 'operations', 'purchasing']) {
    users[role] = await User.create({ username: role, displayName: role, role, passwordHash });
  }
  users.empty = await User.create({
    username: 'empty',
    displayName: '无店铺',
    role: 'operations',
    passwordHash,
  });
  for (const name of ['A', 'B']) {
    stores[name] = await Store.create({
      systemStoreName: name,
      walmartStoreName: name,
      ownerId: name === 'A' ? users.operations.id : users.admin.id,
      clientId: 'test-client',
      clientSecret: 'test-secret',
    });
  }
  const order = await Order.create({ orderNumber: 'SAME-CUSTOMER-ORDER' });
  for (const name of ['A', 'B']) {
    for (let i = 0; i < 2; i++) {
      const item = await OrderItem.create({
        orderId: order.id,
        shopName: name,
        walmartSku: `SKU-${i}`,
        purchaseChannelKey: 'test',
        orderDate: '2026-10-18',
        orderAmount: i ? '0.20' : '0.10',
        fulfillmentParty: 'WFSFulfilled',
        orderStatus: '已发货，虚拟单号发货',
        walmart: {
          orderDate: Date.parse('2026-10-18T01:00:00-08:00'),
          statuses: ['Acknowledged'],
          purchaseOrderId: 'same-po',
          lineNumber: String(i + 1),
        },
      });
      await Purchase.create({
        itemId: item.id,
        reviewStatus: i ? '已审核' : null,
        allocatable: i ? '是' : '否',
        purchaseStatus: i ? '采购成功（已出跟踪号）' : null,
      });
    }
    await WalmartReceipt.create({
      storeId: stores[name].id,
      purchaseOrderId: 'same-po',
      customerOrderId: order.orderNumber,
      raw: {
        orderLines: {
          orderLine: [1, 2].map((lineNumber) => ({
            lineNumber: String(lineNumber),
            refund: {
              refundId: `refund-${name}-${lineNumber}`,
              refundCharges: {
                refundCharge: [
                  {
                    charge: {
                      chargeAmount: { amount: name === 'A' ? '0.10' : '0.20', currency: 'USD' },
                    },
                  },
                ],
              },
            },
          })),
        },
      },
    });
    await updateStoreSnapshot(stores[name], {
      now,
      remoteLoader: async () => structuredClone(remote),
    });
  }
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
  for (const role of Object.keys(users)) {
    const response = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ username: role, password: 'Home-test-123' }),
    });
    assert.equal(response.status, 200);
    cookies[role] = response.headers.get('set-cookie').split(';')[0];
    await response.json();
  }
});
after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await db.close();
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
});
test('实时聚合读取正确关联，迁移可重复执行且不改订单', async () => {
  const snapshot = (await readHome(users.operations, now)).stores[0];
  assert.equal(snapshot.metrics.totalOrders, 1);
  assert.equal(snapshot.metrics.yesterdayOrders, 1);
  assert.equal(snapshot.metrics.totalSales, '0.30');
  assert.equal(snapshot.metrics.pendingPurchase, 1);
  assert.equal(snapshot.metrics.purchaseSuccess, 1);
  assert.equal(await OrderItem.count(), 4);
  assert.equal(await Purchase.count(), 4);
  assert.equal(await StoreSnapshot.count(), 2);
});
test('首页需登录，运营只读取所属店铺，采购和管理员读取全部，无密钥泄漏且查询不记录日志', async () => {
  assert.equal((await fetch(base + '/home')).status, 401);
  const logs = await AuditLog.count();
  for (const [role, count] of [
    ['operations', 1],
    ['purchasing', 2],
    ['admin', 2],
    ['empty', 0],
  ]) {
    const response = await fetch(base + '/home?ownerId=' + users.admin.id, {
      headers: { Cookie: cookies[role] },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.equal(data.stores.length, count);
    assert.doesNotMatch(
      JSON.stringify(data),
      /test-secret|test-client|clientSecret|passwordHash|sourceKey/,
    );
    for (const store of data.stores) {
      const owner = store.name === 'A' ? users.operations : users.admin;
      assert.equal(store.ownerId, owner.id);
      assert.equal(store.ownerUsername, owner.username);
    }
    if (role === 'operations') assert.equal(data.stores[0].name, 'A');
  }
  assert.equal(await AuditLog.count(), logs);
});
test('每日报表按店铺隔离原始退款记录，跨 SKU 去重并遵循账号权限', async () => {
  const home = await readHome(users.operations, now);
  assert.equal(home.daily.length, 30);
  assert.equal(home.dailyStores.length, 30);
  assert.equal(home.endDate, '2026-10-19');
  assert.equal(home.daily[0].totalOrders, 0);
  const day = home.daily[1];
  assert.equal(day.totalOrders, 1);
  assert.equal(day.wfsOrders, 1);
  assert.equal(day.totalSales, '0.30');
  assert.equal(day.refundAmount, '0.20');
  assert.equal(day.reviewed, 1);
  assert.equal(day.unallocatable, 1);
  assert.equal(day.virtualShipped, 2);
  assert.ok(home.dailyStores.every((row) => row.name === 'A'));
  const all = await readHome(users.admin, now);
  assert.equal(all.dailyStores.length, 60);
  assert.equal(all.daily[1].totalOrders, 2);
  assert.equal(all.daily[1].totalSales, '0.60');
  assert.equal(all.daily[1].refundAmount, '0.60');
  assert.equal((await readHome(users.empty, now)).daily[0].totalOrders, 0);
});

test('刷新立即反映今天的新订单和采购变更，不调用 Walmart，也不依赖平台快照', async () => {
  const order = await Order.create({ orderNumber: 'LIVE-TODAY' });
  const originalRequest = WalmartClient.prototype.request;
  let calls = 0;
  WalmartClient.prototype.request = async () => {
    calls++;
    throw new Error('读取统计不能请求平台');
  };
  try {
    const item = await OrderItem.create({
      orderId: order.id,
      shopName: 'A',
      purchaseChannelKey: 'test',
      walmartSku: 'LIVE-SKU',
      orderDate: '2026-10-19',
      orderAmount: '12.34',
      walmart: { orderDate: now, statuses: ['Acknowledged'] },
    });
    const purchase = await Purchase.create({ itemId: item.id, purchaseStatus: '采购中' });
    const first = await readHome(users.operations, now + 1000);
    assert.equal(first.daily[0].date, '2026-10-19');
    assert.equal(first.daily[0].totalOrders, 1);
    assert.equal(first.daily[0].totalSales, '12.34');
    assert.equal(first.daily[0].purchasing, 1);
    await purchase.update({
      purchaseStatus: '采购失败',
      reviewStatus: '已审核',
      allocatable: '是',
    });
    await item.update({ orderAmount: '15.00', orderStatus: '已发货，虚拟单号发货' });
    const second = await readHome(users.operations, now + 2000);
    assert.equal(second.daily[0].totalSales, '15.00');
    assert.equal(second.daily[0].purchasing, 0);
    assert.equal(second.daily[0].purchaseFailed, 1);
    assert.equal(second.daily[0].reviewed, 1);
    assert.equal(second.daily[0].virtualShipped, 1);
    assert.equal(second.stores[0].metrics.totalOrders, 2);
    assert.equal(second.stores[0].metrics.totalSales, '15.30');
    assert.equal(second.stores[0].metrics.yesterdaySales, '0.30');
    const other = await readHome(users.empty, now + 2000);
    assert.equal(other.daily[0].totalOrders, 0);
    assert.equal(calls, 0);
    assert.deepEqual(second.stores[0].remote, first.stores[0].remote);
  } finally {
    WalmartClient.prototype.request = originalRequest;
    await order.destroy();
  }
});

test('28家店铺1200条明细按批次查询，跨批次订单去重与汇总不遗漏', async (t) => {
  const extras = await Store.bulkCreate(
    Array.from({ length: 26 }, (_, i) => ({
      systemStoreName: `BENCH-${i}`,
      walmartStoreName: `BENCH-${i}`,
      clientId: 'test-client',
      clientSecret: 'test-secret',
      ownerId: users.admin.id,
    })),
  );
  const order = await Order.create({ orderNumber: 'PAGED-ORDER' });
  const names = ['A', 'B', ...extras.map((store) => store.systemStoreName)];
  const previousLogging = db.options.logging;
  try {
    await OrderItem.bulkCreate(
      Array.from({ length: 1200 }, (_, i) => ({
        orderId: order.id,
        shopName: names[i % names.length],
        purchaseChannelKey: 'test',
        walmartSku: `BENCH-SKU-${i}`,
        orderDate: '2026-10-19',
        orderAmount: '0.01',
        walmart: { orderDate: now, statuses: ['Acknowledged'] },
      })),
    );
    const queries = [];
    db.options.logging = (sql) => queries.push(sql);
    const started = performance.now();
    const home = await readHome(users.admin, now + 1000);
    const elapsed = performance.now() - started;
    db.options.logging = previousLogging;
    assert.equal(home.stores.length, 28);
    assert.equal(home.daily[0].totalOrders, 28);
    assert.equal(home.daily[0].totalSales, '12.00');
    assert.equal(home.daily[1].totalSales, '0.60');
    assert.equal(home.dailyStores.length, 840);
    assert.equal(
      home.stores.reduce((sum, store) => sum + store.metrics.totalOrders, 0),
      30,
    );
    assert.ok(home.daily.every((day) => day.ready));
    const scans = queries.filter((sql) => sql.includes('FROM `order_items` AS `OrderItem`')).length;
    assert.equal(scans, 3);
    t.diagnostic(
      `28家店铺、1204条明细：${scans}次分页订单查询，耗时${elapsed.toFixed(0)}ms（本地测试库）`,
    );
  } finally {
    db.options.logging = previousLogging;
    await order.destroy();
    for (const store of extras) await store.destroy();
  }
});

test('同一天重启不再次采集，跨日自动更新且不会累积快照', async () => {
  let calls = 0;
  const options = {
    now: now + 1000,
    remoteLoader: async () => {
      calls++;
      return remote;
    },
  };
  assert.equal(await updateStoreSnapshot(stores.A, options), false);
  assert.equal(calls, 0);
  options.now = now + 8 * 3600000;
  assert.equal(await updateStoreSnapshot(stores.A, options), false);
  assert.equal(calls, 0);
  options.now = now + 86400000;
  assert.equal(await updateStoreSnapshot(stores.A, options), true);
  assert.equal(calls, 1);
  assert.deepEqual((await StoreSnapshot.findByPk(stores.A.id)).metrics, {});
  assert.equal(
    (await readHome(users.operations, options.now)).stores[0].metrics.yesterdayOrders,
    0,
  );
  assert.equal(await StoreSnapshot.count(), 2);
});

test('旧平台快照失效时订单统计仍实时可用，保持订单和采购数据不变', async () => {
  const store = stores.A;
  const oldSource = createHash('sha256')
    .update(
      JSON.stringify([
        'seller-performance-daily-v3',
        store.systemStoreName,
        store.clientId,
        store.clientSecret,
      ]),
    )
    .digest('hex');
  const snapshot = await StoreSnapshot.findByPk(store.id);
  await snapshot.update({ sourceKey: oldSource, snapshotDate: '2026-10-19', attempts: 3 });
  const before = await readHome(users.operations, now);
  assert.equal(before.stores[0].metrics.totalOrders, 1);
  assert.deepEqual(before.stores[0].remote, {});
  assert.equal(before.daily[0].ready, true);
  assert.equal(await updateStoreSnapshot(store, { now, remoteLoader: async () => remote }), true);
  const after = await readHome(users.operations, now);
  assert.equal(after.today, '2026-10-19');
  assert.equal(after.daily[0].date, '2026-10-19');
  assert.equal(after.daily[1].totalOrders, 1);
  assert.equal(after.stores[0].metrics.yesterdayOrders, 1);
  assert.equal(await OrderItem.count(), 4);
  assert.equal(await Purchase.count(), 4);
  assert.equal(await StoreSnapshot.count(), 2);
});
test('所属账号转移立即生效，换密钥后旧快照不再展示', async () => {
  await stores.B.update({ ownerId: users.operations.id });
  assert.equal((await readHome(users.operations)).stores.length, 2);
  await stores.B.update({ clientSecret: 'replacement' });
  const home = await readHome(users.admin);
  const store = home.stores.find((row) => row.id === stores.B.id);
  assert.equal(store.ownerId, users.operations.id);
  assert.equal(store.ownerUsername, users.operations.username);
  assert.equal(store.metrics.totalOrders, 1);
  assert.deepEqual(store.remote, {});
});
test('更新期间切换密钥不会把旧凭据数据落入新配置', async () => {
  const before = await StoreSnapshot.findByPk(stores.B.id);
  await updateStoreSnapshot(stores.B, {
    now,
    remoteLoader: async () => {
      await Store.update(
        { clientSecret: 'changed-during-request' },
        { where: { id: stores.B.id } },
      );
      return remote;
    },
  });
  assert.equal((await StoreSnapshot.findByPk(stores.B.id)).sourceKey, before.sourceKey);
});
test('数据库锁防止多个实例同时执行，最多并行两家店铺，删除自动清理快照', async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const running = refreshHomeSnapshots({
    update: async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      enter();
      await hold;
      active--;
    },
  });
  await entered;
  await refreshHomeSnapshots({
    update: async () => {
      throw new Error('不应进入第二个任务');
    },
  });
  release();
  await running;
  assert.equal(calls, 2);
  assert.ok(peak <= 2);
  await stores.B.destroy();
  assert.equal(await StoreSnapshot.count(), 1);
  assert.equal(await OrderItem.count(), 4);
});
