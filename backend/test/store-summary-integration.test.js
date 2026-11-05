import { test as baseTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import {
  db,
  Store,
  User,
  Order,
  OrderItem,
  Purchase,
  itemInclude,
  serializeItem,
  AuditLog,
} from '../src/models.js';
import { StoreSnapshot } from '../src/services/home/model.js';
import { migrateStores } from '../src/migrations.js';
import { saveStore, listStores } from '../src/services/stores.js';
import { readHome, snapshotSource } from '../src/services/home/index.js';
import { settlementSummary } from '../../frontend/src/utils/settlement-summary.js';
const isolated = /^my_order_summary_test_\d+$/.test(config.db.database);
const test = (name, fn) => baseTest(name, { skip: !isolated }, fn);
const now = Date.parse('2026-11-05T07:30:00Z');
let connection,
  created = false,
  admin,
  op,
  other;
const stores = {};
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
  admin = await User.create({
    username: 'a',
    displayName: '管理员',
    role: 'admin',
    passwordHash: 'test',
  });
  op = await User.create({
    username: 'o',
    displayName: '运营甲',
    role: 'operations',
    passwordHash: 'test',
  });
  other = await User.create({
    username: 'b',
    displayName: '运营乙',
    role: 'operations',
    passwordHash: 'test',
  });
  stores.A = await Store.create({
    systemStoreName: '自有A',
    walmartStoreName: 'A',
    ownerId: op.id,
  });
});
after(async () => {
  await db.close();
  if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(config.db.database)}`);
  await connection?.end();
});
async function add(store, number, time, amount, status = 'Acknowledged', sku = 'SKU') {
  const [order] = await Order.findOrCreate({ where: { orderNumber: number } });
  const item = await OrderItem.create({
    shopName: store.systemStoreName,
    orderId: order.id,
    purchaseChannelKey: number,
    walmartSku: sku,
    orderAmount: amount,
    fulfillmentParty: 'WFS',
    walmart: { orderDate: Date.parse(time), statuses: [status] },
  });
  await Purchase.create({
    itemId: item.id,
    purchaseStatus: '采购中',
    allocatable: '是',
    reviewStatus: '已审核',
  });
  return item;
}
test('旧店铺默认自有，迁移可重复；标记保存、读取和日志保留，旧客户端不清除标记', async () => {
  await db.getQueryInterface().removeColumn('stores', 'isThirdParty');
  await migrateStores();
  await migrateStores();
  assert.equal((await stores.A.reload()).isThirdParty, false);
  const data = await saveStore(
    null,
    {
      walmartStoreName: 'B',
      systemStoreName: '三方B',
      ownerId: op.id,
      clientId: 'test',
      clientSecret: 'test',
      isThirdParty: true,
    },
    admin,
  );
  stores.B = await Store.findByPk(data.id);
  const updated = await saveStore(
    data.id,
    { walmartStoreName: 'B', systemStoreName: '三方B', version: data.version },
    admin,
  );
  assert.equal(updated.isThirdParty, true);
  assert.equal((await listStores()).find((s) => s.id === data.id).isThirdParty, true);
  assert.ok(
    (await AuditLog.findOne({ where: { action: 'create_store' } })).details.fields.includes(
      'isThirdParty',
    ),
  );
  await assert.rejects(
    saveStore(
      data.id,
      {
        walmartStoreName: 'B',
        systemStoreName: '三方B',
        version: updated.version,
        isThirdParty: 'true',
      },
      admin,
    ),
    /标记/,
  );
  stores.C = await Store.create({
    systemStoreName: '三方C',
    walmartStoreName: 'C',
    ownerId: other.id,
    isThirdParty: true,
  });
});
test('日期按PST起止包含当天，跨SKU去重，同日按销售额降序；订单列表实时读取标记且不改身份', async () => {
  await add(stores.A, 'OLD', '2026-10-01T09:00:00Z', '500');
  await add(stores.A, 'BEFORE', '2026-11-03T07:59:59Z', '900');
  await add(stores.A, 'SAME', '2026-11-03T08:00:00Z', '10', 'Acknowledged', 'A');
  await add(stores.A, 'SAME', '2026-11-03T08:00:00Z', '20', 'Acknowledged', 'B');
  await add(stores.A, 'LAST', '2026-11-04T07:59:59Z', '100', 'Cancelled');
  await add(stores.A, 'AFTER', '2026-11-04T08:00:00Z', '800');
  const target = await add(stores.B, 'SAME', '2026-11-03T08:00:00Z', '40');
  await add(stores.C, 'C1', '2026-11-03T09:00:00Z', '50');
  const report = await readHome(admin, now, {
    scope: 'summary',
    startDate: '2026-11-03',
    endDate: '2026-11-03',
  });
  assert.deepEqual(
    report.dailyStores.map((r) => r.name),
    ['三方C', '三方B', '自有A'],
  );
  assert.equal(report.daily[0].totalOrders, 4);
  assert.equal(report.daily[0].totalSales, '120.00');
  const a = report.stores.find((s) => s.id === stores.A.id);
  assert.equal(a.metrics.totalOrders, 2);
  assert.equal(a.metrics.totalSales, '30.00');
  assert.equal(a.metrics.cancelledOrders, 1);
  const before = (await target.reload()).toJSON();
  assert.equal(
    serializeItem(await OrderItem.findByPk(target.id, { include: itemInclude })).storeIsThirdParty,
    true,
  );
  await stores.B.update({ isThirdParty: false });
  assert.equal(
    serializeItem(await OrderItem.findByPk(target.id, { include: itemInclude })).storeIsThirdParty,
    false,
  );
  assert.deepEqual((await target.reload()).toJSON(), before);
  await stores.B.update({ isThirdParty: true });
});
test('账号、店铺多选取交集；选项和结果均遵守运营权限，空结果不回退全部', async () => {
  const query = {
    scope: 'summary',
    startDate: '2026-11-03',
    endDate: '2026-11-03',
    ownerId: op.id,
    storeIds: JSON.stringify([stores.B.id, stores.C.id]),
  };
  const report = await readHome(admin, now, query);
  assert.deepEqual(
    report.stores.map((s) => s.id),
    [stores.B.id],
  );
  assert.equal(report.dailyStores.length, 1);
  assert.equal(report.daily[0].totalSales, '40.00');
  assert.equal(report.storeOptions.length, 3);
  assert.ok(!JSON.stringify(report).includes('clientSecret'));
  const restricted = await readHome(op, now, { ...query, ownerId: other.id });
  assert.equal(restricted.stores.length, 0);
  assert.equal(restricted.daily[0].totalSales, '0.00');
  assert.equal(restricted.dailyStores.length, 0);
  assert.deepEqual(
    restricted.storeOptions.map((s) => s.id).sort(),
    [stores.A.id, stores.B.id].sort(),
  );
});
test('远程绩效及金额不被日期筛选重算，按店铺类型分组汇总跨分页', async () => {
  for (const [name, amount] of [
    ['A', '10.00'],
    ['B', '20.00'],
    ['C', '30.00'],
  ]) {
    const store = stores[name];
    await StoreSnapshot.create({
      storeId: store.id,
      sourceKey: snapshotSource(store),
      snapshotDate: '2026-11-04',
      measuredAt: new Date(now),
      attemptedAt: new Date(now),
      attempts: 1,
      metrics: {},
      remote: {
        settlement: { status: 'ok', value: amount, fetchedAt: new Date(now).toISOString() },
        otd: { status: 'ok', value: '99.1', periodDays: 30 },
      },
    });
  }
  const report = await readHome(admin, now, {
    scope: 'summary',
    startDate: '2026-10-01',
    endDate: '2026-10-01',
  });
  assert.equal(report.stores.find((s) => s.id === stores.A.id).metrics.totalSales, '500.00');
  assert.equal(report.stores.find((s) => s.id === stores.B.id).metrics.totalSales, '0.00');
  assert.equal(report.stores[0].remote.otd.value, '99.1');
  assert.equal(
    settlementSummary(
      report.stores.filter((s) => !s.isThirdParty),
      report.today,
    ).value,
    '10.00',
  );
  assert.equal(
    settlementSummary(
      report.stores.filter((s) => s.isThirdParty),
      report.today,
    ).value,
    '50.00',
  );
  const homepage = await readHome(admin, now);
  assert.equal(homepage.daily.length, 30);
  assert.ok(homepage.stores.find((s) => s.id === stores.A.id).metrics.totalOrders > 2);
});
